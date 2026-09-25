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
//   LOG_LEVEL, ENABLED_API_CATEGORIES, REQUEST_TIMEOUT - see odata-mcp-proxy
// =============================================================================
import { execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const DESTINATION_NAME = 'CF_API';
// Refresh the token this many seconds before it expires
const REFRESH_MARGIN_SECONDS = 120;

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
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf-8'));
        return typeof payload.exp === 'number' ? payload.exp : undefined;
    } catch {
        return undefined;
    }
}

function readCfCliTarget() {
    const cfHome = process.env.CF_HOME || homedir();
    const configPath = join(cfHome, '.cf', 'config.json');
    if (!existsSync(configPath)) return undefined;
    try {
        return JSON.parse(readFileSync(configPath, 'utf-8')).Target || undefined;
    } catch {
        return undefined;
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
function publishDestination(apiUrl, accessToken) {
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
        const apiUrl = (process.env.CF_API_URL || (mode === 'cli' ? readCfCliTarget() : undefined))?.replace(/\/+$/, '');
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

process.env.MCP_TRANSPORT = 'stdio';
process.env.API_CONFIG_FILE ||= join(here, 'btp-cf-api-config.json');

await import('odata-mcp-proxy/dist/index.js');
