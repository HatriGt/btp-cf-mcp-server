// =============================================================================
// Cloud Foundry specific MCP tools
//
// Higher-level tools on top of the generic CF V3 entity tools. They accept app
// names as well as GUIDs and fetch independent resources concurrently, so
// common questions ("why is my app down?") take one call instead of five.
// =============================================================================
import { z } from 'zod';
import { decodeJwtPayload, readCfCliConfig } from './auth.mjs';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const text = (value) => ({
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});
const fail = (error) => ({ isError: true, ...text(`Error: ${error instanceof Error ? error.message : String(error)}`) });
const guarded = (fn) => async (args, extra) => {
    try {
        return await fn(args, extra);
    } catch (error) {
        return fail(error);
    }
};

const appInput = {
    app: z.string().min(1).describe('App name or GUID. Names are looked up in space_guid, or in the cf CLI targeted space'),
    space_guid: z.string().optional().describe('Space to look the app name up in (default: the cf CLI targeted space)'),
};

/**
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {object} ctx
 * @param {{get(path: string): Promise<any>, post(path: string, body?: object): Promise<any>}} ctx.api
 * @param {string} ctx.mode                 auth mode (cli | password | destination)
 * @param {string} [ctx.apiUrl]
 * @param {{get(): Promise<string>, current?: string}} [ctx.tokens]  only when the launcher holds the token
 */
export function registerCfTools(server, { api, mode, apiUrl, tokens }) {
    const targetedSpace = () => (mode === 'cli' ? readCfCliConfig().SpaceFields?.GUID : undefined) || process.env.CF_SPACE_GUID;

    async function resolveApp(app, spaceGuid) {
        if (GUID_RE.test(app)) return api.get(`/v3/apps/${app}?include=space.organization`);
        const space = spaceGuid || targetedSpace();
        const query = new URLSearchParams({ names: app, include: 'space.organization', per_page: '50' });
        if (space) query.set('space_guids', space);
        const result = await api.get(`/v3/apps?${query}`);
        const found = result?.resources ?? [];
        if (found.length === 0) {
            throw new Error(`No app named "${app}"${space ? ` in space ${space}` : ''}. ` +
                'Check the name, pass space_guid, or list apps with Apps_list.');
        }
        if (found.length > 1) {
            const spaces = Object.fromEntries((result.included?.spaces ?? []).map((s) => [s.guid, s.name]));
            const options = found.map((a) => {
                const sg = a.relationships?.space?.data?.guid;
                return `${a.guid} (space ${spaces[sg] ?? sg})`;
            });
            throw new Error(`Several apps are named "${app}": ${options.join(', ')}. Pass space_guid or the app GUID.`);
        }
        return { ...found[0], included: result.included };
    }

    // ── CF_Target ────────────────────────────────────────────────────────────
    server.registerTool('CF_Target', {
        title: 'Current Cloud Foundry target',
        description: 'Show the CF API endpoint, the logged-in user, and the org/space targeted with the cf CLI ' +
            '(with GUIDs, usable as organization_guids / space_guids filters). Call this first when the user ' +
            'refers to "my apps", "this space" or similar.',
        inputSchema: {},
        annotations: { readOnlyHint: true, openWorldHint: false },
    }, guarded(async () => {
        const claims = tokens?.current ? decodeJwtPayload(tokens.current) : {};
        const cli = mode === 'cli' ? readCfCliConfig() : {};
        const field = (f) => (f?.GUID ? { name: f.Name, guid: f.GUID } : null);
        return text({
            api: apiUrl ?? '(resolved via BTP Destination service)',
            authMode: mode,
            user: claims.user_name
                ? { name: claims.user_name, email: claims.email, origin: claims.origin, guid: claims.user_id }
                : null,
            tokenExpiresAt: claims.exp ? new Date(claims.exp * 1000).toISOString() : null,
            targetedOrganization: field(cli.OrganizationFields),
            targetedSpace: field(cli.SpaceFields) ?? (process.env.CF_SPACE_GUID ? { guid: process.env.CF_SPACE_GUID } : null),
        });
    }));

    // ── CF_AppSummary ────────────────────────────────────────────────────────
    server.registerTool('CF_AppSummary', {
        title: 'App summary',
        description: 'Everything about one app in a single call, like `cf app`: state, org/space, per-process ' +
            'instances with live CPU/memory/disk usage, routes, bound service instances and the current droplet ' +
            '(buildpacks, stack). Start here to answer questions about an app or to diagnose it.',
        inputSchema: appInput,
        annotations: { readOnlyHint: true },
    }, guarded(async ({ app, space_guid }) => {
        const found = await resolveApp(app, space_guid);
        const guid = found.guid;
        const optional = (p) => p.catch((error) => ((error.status ?? error.httpStatus) === 404 ? null : Promise.reject(error)));

        const [processes, routes, bindings, droplet] = await Promise.all([
            api.get(`/v3/apps/${guid}/processes`),
            api.get(`/v3/apps/${guid}/routes?per_page=100`),
            api.get(`/v3/service_credential_bindings?app_guids=${guid}&type=app&include=service_instance&per_page=100`),
            optional(api.get(`/v3/apps/${guid}/droplets/current`)),
        ]);
        const stats = await Promise.all((processes?.resources ?? []).map((p) =>
            optional(api.get(`/v3/processes/${p.guid}/stats`))));

        const space = found.included?.spaces?.[0];
        const org = found.included?.organizations?.[0];
        const instances = (entry) => (entry?.resources ?? []).map((i) => ({
            index: i.index,
            state: i.state,
            uptimeSeconds: i.uptime,
            cpuPercent: i.usage?.cpu !== undefined ? Math.round(i.usage.cpu * 1000) / 10 : undefined,
            memoryMb: i.usage?.mem !== undefined ? Math.round(i.usage.mem / 1048576) : undefined,
            diskMb: i.usage?.disk !== undefined ? Math.round(i.usage.disk / 1048576) : undefined,
            details: i.details || undefined,
        }));

        return text({
            name: found.name,
            guid,
            state: found.state,
            organization: org ? { name: org.name, guid: org.guid } : undefined,
            space: space ? { name: space.name, guid: space.guid } : undefined,
            lifecycle: found.lifecycle?.type,
            updatedAt: found.updated_at,
            processes: (processes?.resources ?? []).map((p, idx) => {
                const list = instances(stats[idx]);
                return {
                    type: p.type,
                    guid: p.guid,
                    instances: p.instances,
                    running: list.filter((i) => i.state === 'RUNNING').length,
                    memoryLimitMb: p.memory_in_mb,
                    diskLimitMb: p.disk_in_mb,
                    command: p.command ?? undefined,
                    healthCheck: p.health_check?.type,
                    instanceDetails: list,
                };
            }),
            routes: (routes?.resources ?? []).map((r) => r.url),
            services: (bindings?.included?.service_instances ?? []).map((s) => ({ name: s.name, guid: s.guid, type: s.type })),
            droplet: droplet
                ? {
                    state: droplet.state,
                    stack: droplet.stack,
                    buildpacks: (droplet.buildpacks ?? []).map((b) => [b.name, b.version].filter(Boolean).join(' ')),
                    createdAt: droplet.created_at,
                }
                : null,
        });
    }));

    // ── CF_AppAction ─────────────────────────────────────────────────────────
    server.registerTool('CF_AppAction', {
        title: 'Start, stop or restart an app',
        description: 'Start, stop or restart a Cloud Foundry app (POST /v3/apps/<guid>/actions/<action>). ' +
            'Stopping or restarting interrupts the running app.',
        inputSchema: {
            ...appInput,
            action: z.enum(['start', 'stop', 'restart']).describe('Lifecycle action'),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    }, guarded(async ({ app, space_guid, action }) => {
        const { guid } = await resolveApp(app, space_guid);
        const result = await api.post(`/v3/apps/${guid}/actions/${action}`);
        return text({ guid: result?.guid ?? guid, name: result?.name, state: result?.state });
    }));

    // ── CF_AppRecentLogs ─────────────────────────────────────────────────────
    // log-cache is a separate endpoint outside /v3, so it needs the raw token.
    if (!tokens || !apiUrl) return;

    let logCacheUrl;
    const getLogCacheUrl = async () => {
        if (logCacheUrl) return logCacheUrl;
        const res = await fetch(`${apiUrl}/`, { headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(`GET ${apiUrl}/ failed: ${res.status}`);
        const href = (await res.json()).links?.log_cache?.href;
        if (!href) throw new Error('This CF deployment does not advertise a log-cache endpoint.');
        return (logCacheUrl = href.replace(/\/+$/, ''));
    };

    server.registerTool('CF_AppRecentLogs', {
        title: 'Recent app logs',
        description: 'Recent log lines of an app from log-cache, like `cf logs --recent`: app output, staging, ' +
            'router and platform (crash) events. Use it to diagnose crashes or failed starts.',
        inputSchema: {
            ...appInput,
            limit: z.number().int().min(1).max(1000).default(200).describe('Maximum number of log lines (default 200)'),
            errors_only: z.boolean().default(false).describe('Only return stderr (ERR) lines'),
            search: z.string().optional().describe('Only return lines containing this text (case-insensitive)'),
        },
        annotations: { readOnlyHint: true },
    }, guarded(async ({ app, space_guid, limit, errors_only, search }) => {
        const [{ guid }, base] = await Promise.all([resolveApp(app, space_guid), getLogCacheUrl()]);
        const url = `${base}/api/v1/read/${guid}?envelope_types=LOG&descending=true&limit=${limit}`;
        const res = await fetch(url, { headers: { authorization: `Bearer ${await tokens.get()}` } });
        if (!res.ok) throw new Error(`log-cache request failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
        const needle = search?.toLowerCase();
        const lines = ((await res.json()).envelopes?.batch ?? [])
            .filter((e) => e.log && (!errors_only || e.log.type === 'ERR'))
            .reverse()
            .map((e) => {
                const time = new Date(Number(BigInt(e.timestamp) / 1000000n)).toISOString();
                const source = `${e.tags?.source_type ?? '?'}/${e.instance_id || '0'}`;
                const message = Buffer.from(e.log.payload ?? '', 'base64').toString('utf-8').trimEnd();
                return `${time} [${source}] ${e.log.type ?? 'OUT'} ${message}`;
            })
            .filter((line) => !needle || line.toLowerCase().includes(needle));
        return text(lines.length ? lines.join('\n') : 'No matching log lines.');
    }));
}
