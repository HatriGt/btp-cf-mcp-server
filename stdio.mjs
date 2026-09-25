#!/usr/bin/env node
// =============================================================================
// btp-mcp-server — local stdio entry point
//
// Runs odata-mcp-proxy with the stdio transport so MCP clients (Claude Code,
// Claude Desktop, Cursor, ...) can spawn it as a local process, and adds what
// a local Cloud Foundry setup needs:
//   - stdout is reserved for JSON-RPC; all logging goes to stderr
//   - CF UAA token from the cf CLI session or a password grant (lib/auth.mjs)
//   - a CF-aware HTTP client: keep-alive, CF error details, async job URLs,
//     compact responses (lib/cf-client.mjs)
//   - progressive tool discovery and higher-level CF tools (lib/tools.mjs)
//
// Configuration is via environment variables; see README.md.
// =============================================================================
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTokenProvider, readCfCliConfig } from './lib/auth.mjs';
import { compactProxyClient, createCfClient, routeProxyClient } from './lib/cf-client.mjs';
import { registerCfTools } from './lib/tools.mjs';

// ── stdout belongs to JSON-RPC ──────────────────────────────────────────────
// winston's Console transport writes to console._stdout; point it (and any
// stray console.log) at stderr. The MCP stdio transport writes to
// process.stdout directly and is unaffected.
console._stdout = process.stderr;
console.log = console.error;
console.info = console.error;
console.debug = console.error;

const here = dirname(fileURLToPath(import.meta.url));
const log = (msg) => process.stderr.write(`[btp-mcp-server] ${msg}\n`);
const DESTINATION_NAME = 'CF_API';
const DEFAULT_PINNED = ['Apps', 'Processes', 'Spaces', 'Organizations', 'ServiceInstances', 'Routes'];

const mode = (process.env.CF_AUTH_MODE || 'cli').toLowerCase();
const toolMode = (process.env.CF_TOOLS || 'hybrid').toLowerCase();
const compactResponses = !/^(0|false|no|off)$/i.test(process.env.CF_COMPACT ?? '');

function fatal(message) {
    log(message);
    process.exit(1);
}

if (!['cli', 'password', 'destination'].includes(mode)) {
    fatal(`Unknown CF_AUTH_MODE "${mode}" (expected cli, password or destination).`);
}
if (!['hybrid', 'search', 'all'].includes(toolMode)) {
    fatal(`Unknown CF_TOOLS "${toolMode}" (expected hybrid, search or all).`);
}

// ── API endpoint ────────────────────────────────────────────────────────────
let apiUrl;
if (mode === 'destination') {
    // default-env.json and .env are loaded from the working directory
    process.chdir(here);
} else {
    apiUrl = (process.env.CF_API_URL || (mode === 'cli' ? readCfCliConfig().Target : undefined))?.replace(/\/+$/, '');
    if (!apiUrl) {
        fatal('CF API endpoint unknown. Run `cf login -a <api-endpoint>` or set CF_API_URL ' +
            '(e.g. https://api.cf.eu10.hana.ondemand.com).');
    }
}

// ── Tool surface (progressive discovery) ────────────────────────────────────
const baseConfigFile = process.env.API_CONFIG_FILE || join(here, 'btp-cf-api-config.json');
if (toolMode === 'all') {
    process.env.API_CONFIG_FILE = baseConfigFile;
} else {
    const apiConfig = JSON.parse(readFileSync(baseConfigFile, 'utf-8'));
    const known = new Set(apiConfig.apis.flatMap((api) => api.entitySets.map((e) => e.entitySet)));
    const pinned = process.env.CF_PINNED_TOOLS
        ? process.env.CF_PINNED_TOOLS.split(',').map((s) => s.trim()).filter(Boolean)
        : DEFAULT_PINNED.filter((name) => known.has(name));
    apiConfig.discovery ??= toolMode === 'hybrid' ? { mode: 'hybrid', alwaysRegister: pinned } : { mode: 'search' };
    const derived = join(tmpdir(), `btp-mcp-server-${process.pid}.json`);
    writeFileSync(derived, JSON.stringify(apiConfig));
    process.on('exit', () => {
        try { unlinkSync(derived); } catch { /* already gone */ }
    });
    process.env.API_CONFIG_FILE = derived;
}
process.env.MCP_TRANSPORT = 'stdio';

// ── Token + proxy load, concurrently ────────────────────────────────────────
let tokens;
if (mode !== 'destination') {
    tokens = createTokenProvider({
        mode,
        apiUrl,
        log,
        // Also publish the token as an SAP Cloud SDK environment destination,
        // for anything in odata-mcp-proxy that still goes through the SDK.
        onToken: (token) => {
            process.env.destinations = JSON.stringify([{
                name: DESTINATION_NAME,
                url: apiUrl,
                authentication: 'NoAuthentication',
                headers: { authorization: `Bearer ${token}` },
            }]);
        },
    });
    // odata-mcp-proxy resolves destinations by name only when VCAP_SERVICES is set
    process.env.VCAP_SERVICES ||= '{}';
}

const [proxy] = await Promise.all([
    import('odata-mcp-proxy'),
    tokens?.get().catch((error) => fatal(error.message)),
]);

// The SAP Cloud SDK logs every destination lookup at info level
try {
    const { setGlobalLogLevel } = await import('@sap-cloud-sdk/util');
    setGlobalLogLevel(process.env.LOG_LEVEL === 'debug' ? 'info' : 'warn');
} catch {
    // optional
}

const cfClient = tokens
    ? createCfClient({ apiUrl, tokens, timeout: Number(process.env.REQUEST_TIMEOUT) || 60000, compactResponses })
    : undefined;

function registerExtras(server, ctx) {
    const proxyClient = ctx.clientsByApi['cf-v3'];
    let api;
    if (cfClient) {
        if (proxyClient) routeProxyClient(proxyClient, cfClient);
        api = cfClient;
    } else if (proxyClient) {
        if (compactResponses) compactProxyClient(proxyClient);
        const strip = (path) => path.replace(/^\/v3\//, '');
        api = {
            get: (path) => proxyClient.execute('GET', strip(path)),
            post: (path, body) => proxyClient.execute('POST', strip(path), body),
        };
    }
    if (api) registerCfTools(server, { api, mode, apiUrl, tokens });
}

log(`CF API ${apiUrl ?? '(BTP Destination service)'} | auth: ${mode} | tools: ${toolMode}`);
await proxy.start({ registerExtras });
