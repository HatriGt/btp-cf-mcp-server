#!/usr/bin/env node
// =============================================================================
// Local stdio launcher for the BTP CF MCP server
//
// Runs odata-mcp-proxy with the stdio transport so MCP clients (Claude Desktop,
// Claude Code, Cursor, ...) can spawn it as a local process instead of calling
// a server hosted on BTP.
//
// What this adds on top of `odata-mcp-proxy`:
//   1. Keeps stdout clean for JSON-RPC: all log output is redirected to stderr.
//   2. Resolves the config file relative to this script, so the client's
//      working directory does not matter.
//   3. Obtains a Cloud Foundry UAA user token locally and injects it as an
//      SAP Cloud SDK environment destination (with an Authorization header),
//      refreshing it before it expires. No BTP Destination service needed.
//
// Auth modes (selected via CF_AUTH_MODE, default "cli"):
//   cli         - reuse your `cf login` session (runs `cf oauth-token`).
//                 Works with SSO logins (`cf login --sso`).
//   password    - OAuth2 password grant against CF UAA using CF_USERNAME /
//                 CF_PASSWORD (technical user without 2FA). Requires CF_API_URL.
//   destination - use the BTP Destination service as the hosted app does;
//                 needs VCAP_SERVICES or a default-env.json next to this file.
//
// Optional environment variables:
//   CF_API_URL      - CF API endpoint, e.g. https://api.cf.eu10.hana.ondemand.com
//                     (cli mode defaults to the target of the cf CLI)
//   CF_HOME         - cf CLI home directory (passed through to `cf`)
//   CF_CLI_PATH     - path to the cf binary (default: "cf" from PATH)
//   CF_TOOLS        - tool surface: "hybrid" (default) registers individual
//                     tools only for the most used entity sets plus the
//                     search_operations / execute_operation meta-tools;
//                     "search" registers only the meta-tools; "all" registers
//                     every operation as its own tool (~116 tools)
//   CF_PINNED_TOOLS - comma-separated entity sets kept as individual tools in
//                     hybrid mode (default: Apps,Processes,Spaces,
//                     Organizations,ServiceInstances,Routes)
//   LOG_LEVEL, ENABLED_API_CATEGORIES, REQUEST_TIMEOUT - see odata-mcp-proxy
// =============================================================================
import { execFile } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const DESTINATION_NAME = 'CF_API';
// Refresh the token this many seconds before it expires
const REFRESH_MARGIN_SECONDS = 120;
const DEFAULT_PINNED = ['Apps', 'Processes', 'Spaces', 'Organizations', 'ServiceInstances', 'Routes'];

// ── 1. stdout belongs to JSON-RPC ───────────────────────────────────────────
// winston's Console transport writes to console._stdout; point it (and any
// stray console.log) at stderr. The MCP stdio transport writes to
// process.stdout directly and is unaffected.
console._stdout = process.stderr;
console.log = console.error;
console.info = console.error;
console.debug = console.error;

const log = (msg) => process.stderr.write(`[stdio-launcher] ${msg}\n`);

// ── 2. Token helpers ────────────────────────────────────────────────────────
function decodeJwtExp(token) {
    const { exp } = decodeJwtPayload(token);
    return typeof exp === 'number' ? exp : undefined;
}

function decodeJwtPayload(token) {
    try {
        return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf-8'));
    } catch {
        return {};
    }
}

function readCfCliConfig() {
    const cfHome = process.env.CF_HOME || homedir();
    const configPath = join(cfHome, '.cf', 'config.json');
    if (!existsSync(configPath)) return {};
    try {
        return JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
        return {};
    }
}

async function tokenFromCfCli() {
    const cf = process.env.CF_CLI_PATH || 'cf';
    // `cf oauth-token` refreshes the token if needed and persists it in the
    // cf CLI config, so the CLI session stays in sync.
    const { stdout } = await execFileAsync(cf, ['oauth-token'], { timeout: 30000 });
    const token = stdout.trim().replace(/^bearer\s+/i, '');
    if (!token) throw new Error('`cf oauth-token` returned no token. Run `cf login` first.');
    return { accessToken: token, exp: decodeJwtExp(token) };
}

async function discoverTokenEndpoint(apiUrl) {
    const res = await fetch(`${apiUrl}/`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`GET ${apiUrl}/ failed: ${res.status} ${res.statusText}`);
    const links = (await res.json()).links ?? {};
    const base = links.uaa?.href ?? links.login?.href;
    if (!base) throw new Error(`Could not discover the UAA endpoint from ${apiUrl}/`);
    return `${base.replace(/\/+$/, '')}/oauth/token`;
}

let passwordState; // { tokenUrl, refreshToken }
async function tokenFromPasswordGrant(apiUrl) {
    const username = process.env.CF_USERNAME;
    const password = process.env.CF_PASSWORD;
    if (!username || !password) {
        throw new Error('CF_AUTH_MODE=password requires CF_USERNAME and CF_PASSWORD.');
    }
    passwordState ??= { tokenUrl: await discoverTokenEndpoint(apiUrl) };

    const request = async (params) => {
        const res = await fetch(passwordState.tokenUrl, {
            method: 'POST',
            headers: {
                // Public "cf" client with an empty secret, as used by the cf CLI
                authorization: `Basic ${Buffer.from('cf:').toString('base64')}`,
                'content-type': 'application/x-www-form-urlencoded',
                accept: 'application/json',
            },
            body: new URLSearchParams(params),
        });
        if (!res.ok) throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
        return res.json();
    };

    let body;
    if (passwordState.refreshToken) {
        try {
            body = await request({ grant_type: 'refresh_token', refresh_token: passwordState.refreshToken });
        } catch (error) {
            log(`Refresh failed, falling back to password grant: ${error.message}`);
        }
    }
    body ??= await request({ grant_type: 'password', username, password });
    passwordState.refreshToken = body.refresh_token ?? passwordState.refreshToken;
    const exp = body.expires_in ? Math.floor(Date.now() / 1000) + body.expires_in : decodeJwtExp(body.access_token);
    return { accessToken: body.access_token, exp };
}

// ── 3. Inject the token as an SAP Cloud SDK environment destination ─────────
// Latest token, also used by the extra tools that call CF endpoints outside
// the /v3 API (e.g. log-cache).
const session = { apiUrl: undefined, accessToken: undefined };

function publishDestination(apiUrl, accessToken) {
    session.apiUrl = apiUrl;
    session.accessToken = accessToken;
    process.env.destinations = JSON.stringify([
        {
            name: DESTINATION_NAME,
            url: apiUrl,
            authentication: 'NoAuthentication',
            headers: { authorization: `Bearer ${accessToken}` },
        },
    ]);
}

async function startTokenRefresh(apiUrl, fetchToken) {
    const refresh = async () => {
        const { accessToken, exp } = await fetchToken();
        publishDestination(apiUrl, accessToken);
        const secondsLeft = exp ? exp - Math.floor(Date.now() / 1000) : 600;
        const delay = Math.max(30, secondsLeft - REFRESH_MARGIN_SECONDS) * 1000;
        const timer = setTimeout(() => {
            refresh().catch((error) => {
                log(`Token refresh failed, retrying in 30s: ${error.message}`);
                setTimeout(() => void refresh().catch(() => {}), 30000).unref();
            });
        }, delay);
        timer.unref();
    };
    await refresh();
}

// ── 4. Configure and start odata-mcp-proxy ──────────────────────────────────
const mode = (process.env.CF_AUTH_MODE || 'cli').toLowerCase();

try {
    if (mode === 'destination') {
        // default-env.json and .env are loaded from the working directory
        process.chdir(here);
    } else {
        const apiUrl = (process.env.CF_API_URL || (mode === 'cli' ? readCfCliConfig().Target : undefined))?.replace(/\/+$/, '');
        if (!apiUrl) {
            throw new Error('CF API endpoint unknown. Set CF_API_URL (e.g. https://api.cf.eu10.hana.ondemand.com) or run `cf login`.');
        }
        if (mode === 'cli') {
            await startTokenRefresh(apiUrl, tokenFromCfCli);
        } else if (mode === 'password') {
            await startTokenRefresh(apiUrl, () => tokenFromPasswordGrant(apiUrl));
        } else {
            throw new Error(`Unknown CF_AUTH_MODE "${mode}" (expected cli, password or destination).`);
        }
        // odata-mcp-proxy only asks the SAP Cloud SDK to resolve the destination
        // by name when VCAP_SERVICES is set; the SDK then finds it in
        // process.env.destinations before trying any BTP service.
        process.env.VCAP_SERVICES ||= '{}';
        log(`Using CF API ${apiUrl} (auth mode: ${mode})`);
    }
} catch (error) {
    log(error.message);
    process.exit(1);
}


// ── 5. Tool surface (progressive discovery) ─────────────────────────────────
// Registering every operation as its own tool produces ~116 tools, which costs
// context and exceeds the tool limit of some clients. odata-mcp-proxy's
// discovery mode collapses them into search_operations / execute_operation.
const baseConfigFile = process.env.API_CONFIG_FILE || join(here, 'btp-cf-api-config.json');
const toolMode = (process.env.CF_TOOLS || 'hybrid').toLowerCase();

if (toolMode === 'all') {
    process.env.API_CONFIG_FILE = baseConfigFile;
} else if (toolMode === 'hybrid' || toolMode === 'search') {
    const apiConfig = JSON.parse(readFileSync(baseConfigFile, 'utf-8'));
    const known = new Set(apiConfig.apis.flatMap((api) => api.entitySets.map((e) => e.entitySet)));
    const pinned = process.env.CF_PINNED_TOOLS
        ? process.env.CF_PINNED_TOOLS.split(',').map((s) => s.trim()).filter(Boolean)
        : DEFAULT_PINNED.filter((name) => known.has(name));
    apiConfig.discovery ??= toolMode === 'hybrid' ? { mode: 'hybrid', alwaysRegister: pinned } : { mode: 'search' };
    const derived = join(tmpdir(), `btp-cf-mcp-server-${process.pid}.json`);
    writeFileSync(derived, JSON.stringify(apiConfig));
    process.on('exit', () => {
        try { unlinkSync(derived); } catch { /* already gone */ }
    });
    process.env.API_CONFIG_FILE = derived;
} else {
    log(`Unknown CF_TOOLS "${toolMode}" (expected hybrid, search or all).`);
    process.exit(1);
}

process.env.MCP_TRANSPORT = 'stdio';

// The SAP Cloud SDK logs every destination lookup at info level; keep it quiet
// unless debugging.
try {
    const { setGlobalLogLevel } = await import('@sap-cloud-sdk/util');
    setGlobalLogLevel(process.env.LOG_LEVEL === 'debug' ? 'info' : 'warn');
} catch {
    // optional
}

// ── 6. Cloud Foundry specific tools ─────────────────────────────────────────
const text = (value) => ({
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});
const fail = (error) => ({ isError: true, ...text(error instanceof Error ? error.message : String(error)) });

async function cfRoot() {
    const res = await fetch(`${session.apiUrl}/`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`GET ${session.apiUrl}/ failed: ${res.status}`);
    return (await res.json()).links ?? {};
}

function registerExtras(server, ctx) {
    const cf = ctx.clientsByApi['cf-v3'];

    server.registerTool('CF_Target', {
        description: 'Show who and where you are in Cloud Foundry: the CF API endpoint, the logged-in user, ' +
            'and the org/space currently targeted with the cf CLI (with GUIDs, ready to use as space_guids / ' +
            'organization_guids filters). Call this first when the user refers to "my apps" or "this space".',
        inputSchema: {},
        annotations: { readOnlyHint: true },
    }, async () => {
        try {
            const claims = session.accessToken ? decodeJwtPayload(session.accessToken) : {};
            const cli = mode === 'cli' ? readCfCliConfig() : {};
            const field = (f) => (f?.GUID ? { name: f.Name, guid: f.GUID } : null);
            return text({
                api: session.apiUrl ?? '(resolved via BTP Destination service)',
                authMode: mode,
                user: claims.user_name
                    ? { name: claims.user_name, email: claims.email, origin: claims.origin, guid: claims.user_id }
                    : null,
                tokenExpiresAt: claims.exp ? new Date(claims.exp * 1000).toISOString() : null,
                targetedOrganization: field(cli.OrganizationFields),
                targetedSpace: field(cli.SpaceFields),
            });
        } catch (error) {
            return fail(error);
        }
    });

    if (cf) {
        server.registerTool('CF_AppAction', {
            description: 'Start, stop or restart a Cloud Foundry app by GUID (POST /v3/apps/<guid>/actions/<action>). ' +
                'Stopping or restarting interrupts the running app. Look up the GUID with Apps_list ' +
                "(path '?names=<app-name>&space_guids=<space-guid>').",
            inputSchema: {
                app_guid: z.string().min(1).describe('GUID of the app'),
                action: z.enum(['start', 'stop', 'restart']).describe('Lifecycle action'),
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
        }, async ({ app_guid, action }, extra) => {
            try {
                const app = await cf.execute('POST', `apps/${encodeURIComponent(app_guid)}/actions/${action}`,
                    undefined, undefined, extra.authInfo?.token);
                return text({ guid: app?.guid ?? app_guid, name: app?.name, state: app?.state });
            } catch (error) {
                return fail(error);
            }
        });
    }

    // Log-cache lives outside the /v3 API, so it needs the raw token.
    if (mode !== 'destination') {
        server.registerTool('CF_AppRecentLogs', {
            description: 'Fetch recent log lines of a Cloud Foundry app from log-cache (like `cf logs --recent`): ' +
                'app output, staging, router and platform events. Use it to diagnose crashes or failed starts.',
            inputSchema: {
                app_guid: z.string().min(1).describe('GUID of the app'),
                limit: z.number().int().min(1).max(1000).default(200).describe('Maximum number of log lines (default 200)'),
                errors_only: z.boolean().default(false).describe('Only return stderr (ERR) lines'),
            },
            annotations: { readOnlyHint: true },
        }, async ({ app_guid, limit, errors_only }) => {
            try {
                const logCache = (await cfRoot()).log_cache?.href;
                if (!logCache) throw new Error('This CF deployment does not advertise a log-cache endpoint.');
                const url = `${logCache.replace(/\/+$/, '')}/api/v1/read/${encodeURIComponent(app_guid)}` +
                    `?envelope_types=LOG&descending=true&limit=${limit}`;
                const res = await fetch(url, { headers: { authorization: `Bearer ${session.accessToken}` } });
                if (!res.ok) throw new Error(`log-cache request failed: ${res.status} ${await res.text()}`);
                const batch = (await res.json()).envelopes?.batch ?? [];
                const lines = batch
                    .filter((e) => e.log && (!errors_only || e.log.type === 'ERR'))
                    .reverse()
                    .map((e) => {
                        const time = new Date(Number(BigInt(e.timestamp) / 1000000n)).toISOString();
                        const source = `${e.tags?.source_type ?? '?'}/${e.instance_id ?? '0'}`;
                        const message = Buffer.from(e.log.payload ?? '', 'base64').toString('utf-8').trimEnd();
                        return `${time} [${source}] ${e.log.type ?? 'OUT'} ${message}`;
                    });
                return text(lines.length ? lines.join('\n') : 'No recent log lines.');
            } catch (error) {
                return fail(error);
            }
        });
    }
}

const { start } = await import('odata-mcp-proxy');
await start({ registerExtras });
