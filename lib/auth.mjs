// =============================================================================
// Cloud Foundry UAA token handling
//
// Modes:
//   cli      - reuse the cf CLI session. The cached access token in
//              ~/.cf/config.json is used while it is valid (no process spawn);
//              otherwise `cf oauth-token` refreshes it (and persists it for the
//              CLI as well).
//   password - OAuth2 password grant against CF UAA with the public "cf"
//              client, refreshed with the refresh token.
// =============================================================================
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Refresh this many seconds before the token expires. */
const REFRESH_MARGIN_SECONDS = 120;

export function decodeJwtPayload(token) {
    try {
        return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf-8'));
    } catch {
        return {};
    }
}

function secondsLeft(token) {
    const { exp } = decodeJwtPayload(token);
    return typeof exp === 'number' ? exp - Math.floor(Date.now() / 1000) : undefined;
}

export function readCfCliConfig() {
    const configPath = join(process.env.CF_HOME || homedir(), '.cf', 'config.json');
    if (!existsSync(configPath)) return {};
    try {
        return JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
        return {};
    }
}

const stripBearer = (value) => (value ?? '').trim().replace(/^bearer\s+/i, '');

async function cliToken({ force }) {
    if (!force) {
        const cached = stripBearer(readCfCliConfig().AccessToken);
        const left = cached ? secondsLeft(cached) : undefined;
        if (left !== undefined && left > REFRESH_MARGIN_SECONDS + 60) return cached;
    }
    const cf = process.env.CF_CLI_PATH || 'cf';
    let stdout;
    try {
        ({ stdout } = await execFileAsync(cf, ['oauth-token'], { timeout: 30000 }));
    } catch (error) {
        const reason = error.code === 'ENOENT'
            ? `cf CLI not found ("${cf}"). Install it or set CF_CLI_PATH.`
            : (error.stderr || error.stdout || error.message).trim();
        throw new Error(`cf oauth-token failed: ${reason}. Run \`cf login\` and try again.`);
    }
    const token = stripBearer(stdout);
    if (!token) throw new Error('`cf oauth-token` returned no token. Run `cf login` first.');
    return token;
}

async function discoverTokenEndpoint(apiUrl) {
    const res = await fetch(`${apiUrl}/`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`GET ${apiUrl}/ failed: ${res.status} ${res.statusText}`);
    const links = (await res.json()).links ?? {};
    const base = links.uaa?.href ?? links.login?.href;
    if (!base) throw new Error(`Could not discover the UAA endpoint from ${apiUrl}/`);
    return `${base.replace(/\/+$/, '')}/oauth/token`;
}

function passwordGrant(apiUrl) {
    const username = process.env.CF_USERNAME;
    const password = process.env.CF_PASSWORD;
    if (!username || !password) {
        throw new Error('CF_AUTH_MODE=password requires CF_USERNAME and CF_PASSWORD.');
    }
    const state = { tokenUrl: undefined, refreshToken: undefined };

    const request = async (params) => {
        state.tokenUrl ??= await discoverTokenEndpoint(apiUrl);
        const res = await fetch(state.tokenUrl, {
            method: 'POST',
            headers: {
                // Public "cf" client with an empty secret, as used by the cf CLI
                authorization: `Basic ${Buffer.from('cf:').toString('base64')}`,
                'content-type': 'application/x-www-form-urlencoded',
                accept: 'application/json',
            },
            body: new URLSearchParams(params),
        });
        if (!res.ok) throw new Error(`UAA token request failed: ${res.status} ${await res.text()}`);
        return res.json();
    };

    return async () => {
        let body;
        if (state.refreshToken) {
            body = await request({ grant_type: 'refresh_token', refresh_token: state.refreshToken }).catch(() => undefined);
        }
        body ??= await request({ grant_type: 'password', username, password });
        state.refreshToken = body.refresh_token ?? state.refreshToken;
        return body.access_token;
    };
}

/**
 * Create a token provider. `get()` returns a valid token (fetching on first
 * use), `refresh()` forces a new one (e.g. after a 401). Every new token is
 * passed to `onToken`.
 */
export function createTokenProvider({ mode, apiUrl, onToken, log }) {
    const fetchToken = mode === 'password' ? passwordGrant(apiUrl) : (opts) => cliToken(opts);
    let current;
    let pending;
    let timer;

    const schedule = (token) => {
        clearTimeout(timer);
        const left = secondsLeft(token) ?? 600;
        timer = setTimeout(() => {
            // Not forced: the CLI may already have refreshed its cached token
            refresh(false).catch((error) => log(`Token refresh failed: ${error.message}`));
        }, Math.max(30, left - REFRESH_MARGIN_SECONDS) * 1000);
        timer.unref();
    };

    const refresh = (force = true) => {
        pending ??= fetchToken({ force })
            .then((token) => {
                current = token;
                onToken?.(token);
                schedule(token);
                return token;
            })
            .finally(() => {
                pending = undefined;
            });
        return pending;
    };

    return {
        get: async () => current ?? refresh(false),
        refresh: () => refresh(true),
        get current() {
            return current;
        },
    };
}
