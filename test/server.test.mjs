// End-to-end tests: spawn the stdio server against a mock CF API and talk
// JSON-RPC to it over stdin/stdout, exactly like an MCP client does.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { APP, SPACE, startMockCf } from './mock-cf.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function makeToken(claims) {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}.sig`;
}

// Token cached in the cf CLI config (rejected by the API, as if revoked) and
// the one `cf oauth-token` hands out after a refresh.
const CACHED_TOKEN = makeToken({ user_name: 'jane@example.com', email: 'jane@example.com', origin: 'sap.ids', v: 1 });
const FRESH_TOKEN = makeToken({ user_name: 'jane@example.com', email: 'jane@example.com', origin: 'sap.ids', v: 2 });

class McpProcess {
    constructor(env) {
        this.child = spawn(process.execPath, [join(root, 'stdio.mjs')], {
            cwd: tmpdir(),
            env: { ...process.env, LOG_LEVEL: 'error', ...env },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.nextId = 1;
        this.pending = new Map();
        this.nonJsonLines = [];
        this.stderr = '';
        this.child.stderr.on('data', (d) => (this.stderr += d));
        createInterface({ input: this.child.stdout }).on('line', (line) => {
            let message;
            try {
                message = JSON.parse(line);
            } catch {
                this.nonJsonLines.push(line);
                return;
            }
            const waiter = this.pending.get(message.id);
            if (waiter) {
                this.pending.delete(message.id);
                waiter(message);
            }
        });
    }

    request(method, params = {}) {
        const id = this.nextId++;
        const response = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${method}. stderr:\n${this.stderr}`)), 15000);
            this.pending.set(id, (message) => {
                clearTimeout(timer);
                resolve(message);
            });
        });
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        return response;
    }

    async initialize() {
        const res = await this.request('initialize', {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
        });
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
        return res;
    }

    async tools() {
        return (await this.request('tools/list')).result.tools;
    }

    async call(name, args = {}) {
        const { result, error } = await this.request('tools/call', { name, arguments: args });
        assert.equal(error, undefined, JSON.stringify(error));
        return { isError: Boolean(result.isError), text: result.content[0].text };
    }

    close() {
        this.child.kill();
    }
}

describe('btp-mcp-server (cli auth mode)', () => {
    let mock;
    let dir;
    let cfMarker;
    let env;

    before(async () => {
        mock = await startMockCf({ validTokens: [FRESH_TOKEN] });
        dir = mkdtempSync(join(tmpdir(), 'btp-cf-mcp-test-'));
        mkdirSync(join(dir, 'bin'));
        mkdirSync(join(dir, 'home', '.cf'), { recursive: true });
        cfMarker = join(dir, 'cf-called');
        const cf = join(dir, 'bin', 'cf');
        writeFileSync(cf, `#!/bin/sh\ntouch "${cfMarker}"\necho "bearer ${FRESH_TOKEN}"\n`);
        chmodSync(cf, 0o755);
        writeFileSync(join(dir, 'home', '.cf', 'config.json'), JSON.stringify({
            Target: mock.url,
            AccessToken: `bearer ${CACHED_TOKEN}`,
            OrganizationFields: { GUID: 'org-guid', Name: 'my-org' },
            SpaceFields: { GUID: SPACE.guid, Name: SPACE.name },
        }));
        env = { CF_HOME: join(dir, 'home'), CF_CLI_PATH: cf };
    });

    after(async () => {
        await mock.close();
        rmSync(dir, { recursive: true, force: true });
    });

    describe('default (hybrid) tool mode', () => {
        let server;
        before(async () => {
            server = new McpProcess(env);
        });
        after(() => server.close());

        test('initializes without spawning the cf CLI when the cached token is valid', async () => {
            const res = await server.initialize();
            assert.equal(res.result.serverInfo.name, 'btp-mcp-server');
            assert.equal(existsSync(cfMarker), false, 'cf CLI should not be called at startup');
        });

        test('registers pinned entity tools, meta-tools and CF tools', async () => {
            const names = (await server.tools()).map((t) => t.name);
            for (const name of ['Apps_list', 'Spaces_get', 'search_operations', 'execute_operation',
                'CF_Target', 'CF_AppSummary', 'CF_AppAction', 'CF_AppRecentLogs']) {
                assert.ok(names.includes(name), `missing ${name}`);
            }
            assert.ok(!names.includes('Buildpacks_list'), 'non-pinned entity sets must go through discovery');
            assert.ok(names.length < 40, `expected < 40 tools, got ${names.length}`);
        });

        test('retries once with a refreshed token on 401', async () => {
            const res = await server.call('Apps_list', { path: '?names=web-app' });
            assert.equal(res.isError, false, res.text);
            assert.equal(existsSync(cfMarker), true, 'cf oauth-token should be called after the 401');
        });

        test('compacts responses: drops resource links and empty metadata, keeps pagination', async () => {
            const body = JSON.parse((await server.call('Apps_list', {})).text);
            assert.ok(body.pagination.first.href, 'pagination links are kept');
            assert.equal(body.resources.length, 3);
            for (const app of body.resources) {
                assert.equal(app.links, undefined);
                assert.equal(app.metadata, undefined);
                assert.ok(app.relationships.space.data.guid);
            }
        });

        test('reports CF error details', async () => {
            const res = await server.call('Apps_create', { body: { name: 'web-app' } });
            assert.equal(res.isError, true);
            assert.match(res.text, /HTTP 422/);
            assert.match(res.text, /CF-UniquenessError: App with the name 'web-app' already exists/);
        });

        test('returns the job URL for asynchronous operations', async () => {
            const body = JSON.parse((await server.call('Apps_delete', { path: `/${APP.guid}` })).text);
            assert.equal(body.accepted, true);
            assert.match(body.job, /\/v3\/jobs\/eeeeeeee/);
        });

        test('discovery executes CF REST paths', async () => {
            const res = await server.call('execute_operation', {
                api: 'cf-v3', entitySet: 'Stacks', operation: 'list', path: '?names=cflinuxfs4',
            });
            assert.equal(res.isError, false, res.text);
            assert.ok(mock.state.requests.includes('GET /v3/stacks?names=cflinuxfs4'));
        });

        test('CF_Target reports user and targeted org/space', async () => {
            const body = JSON.parse((await server.call('CF_Target')).text);
            assert.equal(body.api, mock.url);
            assert.equal(body.user.name, 'jane@example.com');
            assert.deepEqual(body.targetedSpace, { name: SPACE.name, guid: SPACE.guid });
        });

        test('CF_AppSummary resolves an app name in the targeted space', async () => {
            const body = JSON.parse((await server.call('CF_AppSummary', { app: 'web-app' })).text);
            assert.equal(body.guid, APP.guid);
            assert.equal(body.space.name, 'dev');
            assert.equal(body.organization.name, 'my-org');
            assert.deepEqual(body.routes, ['web-app.cfapps.eu10.hana.ondemand.com']);
            assert.deepEqual(body.services.map((s) => s.name), ['my-db']);
            assert.deepEqual(body.droplet.buildpacks, ['nodejs_buildpack 1.8.0']);
            const web = body.processes[0];
            assert.equal(web.instances, 2);
            assert.equal(web.running, 1);
            assert.equal(web.instanceDetails[0].memoryMb, 128);
            assert.equal(web.instanceDetails[1].details, 'exited with status 1');
        });

        test('CF tools scope app names to the targeted space and explain unknown names', async () => {
            // "twin" exists in two spaces, but only once in the targeted one
            const scoped = await server.call('CF_AppSummary', { app: 'twin' });
            assert.equal(scoped.isError, false, scoped.text);
            const missing = await server.call('CF_AppAction', { app: 'nope', action: 'restart' });
            assert.equal(missing.isError, true);
            assert.match(missing.text, /No app named "nope"/);
        });

        test('CF_AppAction restarts an app by name', async () => {
            const body = JSON.parse((await server.call('CF_AppAction', { app: 'web-app', action: 'restart' })).text);
            assert.equal(body.state, 'STARTED');
            assert.ok(mock.state.requests.includes(`POST /v3/apps/${APP.guid}/actions/restart`));
        });

        test('CF_AppRecentLogs decodes log-cache envelopes', async () => {
            const all = await server.call('CF_AppRecentLogs', { app: 'web-app' });
            assert.match(all.text, /\[APP\/PROC\/WEB\/0\] OUT listening on 8080\n.*\[APP\/PROC\/WEB\/1\] ERR Error: connect ECONNREFUSED/);
            const errors = await server.call('CF_AppRecentLogs', { app: APP.guid, errors_only: true });
            assert.doesNotMatch(errors.text, /listening/);
            const search = await server.call('CF_AppRecentLogs', { app: APP.guid, search: 'econnrefused' });
            assert.match(search.text, /ECONNREFUSED/);
        });

        test('reuses connections (keep-alive)', () => {
            const apiRequests = mock.state.requests.filter((r) => !r.startsWith('GET / ')).length;
            assert.ok(apiRequests > 10);
            // Parallel requests (CF_AppSummary) legitimately open a few sockets;
            // without pooling every request would open its own.
            assert.ok(mock.state.connections <= 6, `expected pooled connections, got ${mock.state.connections} for ${apiRequests} requests`);
        });

        test('writes nothing but JSON-RPC to stdout', () => {
            assert.deepEqual(server.nonJsonLines, []);
        });
    });

    test('CF_TOOLS=search exposes only meta-tools and CF tools', async () => {
        const server = new McpProcess({ ...env, CF_TOOLS: 'search' });
        try {
            await server.initialize();
            const names = (await server.tools()).map((t) => t.name).sort();
            assert.deepEqual(names, ['CF_AppAction', 'CF_AppRecentLogs', 'CF_AppSummary', 'CF_Target',
                'execute_operation', 'search_operations']);
        } finally {
            server.close();
        }
    });

    test('CF_TOOLS=all registers every operation', async () => {
        const server = new McpProcess({ ...env, CF_TOOLS: 'all' });
        try {
            await server.initialize();
            const names = (await server.tools()).map((t) => t.name);
            assert.ok(names.length > 100, `expected > 100 tools, got ${names.length}`);
            assert.ok(names.includes('Buildpacks_list'));
        } finally {
            server.close();
        }
    });

    test('CF_COMPACT=false returns raw CF responses', async () => {
        const server = new McpProcess({ ...env, CF_COMPACT: 'false' });
        try {
            await server.initialize();
            const body = JSON.parse((await server.call('Apps_list', {})).text);
            assert.ok(body.resources[0].links.self.href);
        } finally {
            server.close();
        }
    });

    test('fails fast with a clear message on invalid settings', async () => {
        const server = new McpProcess({ ...env, CF_TOOLS: 'bogus' });
        const code = await new Promise((resolve) => server.child.on('exit', resolve));
        assert.equal(code, 1);
        assert.match(server.stderr, /Unknown CF_TOOLS "bogus"/);
    });
});
