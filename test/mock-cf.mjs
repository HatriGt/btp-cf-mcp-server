// Minimal Cloud Foundry V3 API + log-cache mock with realistic payload shapes.
import http from 'node:http';

export const SPACE = { guid: '11111111-1111-4111-8111-111111111111', name: 'dev' };
export const OTHER_SPACE = { guid: '22222222-2222-4222-8222-222222222222', name: 'prod' };
export const ORG = { guid: '33333333-3333-4333-8333-333333333333', name: 'my-org' };
export const APP = { guid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'web-app' };
const PROCESS_GUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function links(base, guid, extra = []) {
    const out = { self: { href: `${base}/v3/${guid}` } };
    for (const name of extra) out[name] = { href: `${base}/v3/${guid}/${name}` };
    return out;
}

function app(base, guid, name, space) {
    return {
        guid,
        name,
        state: 'STARTED',
        created_at: '2026-09-01T10:00:00Z',
        updated_at: '2026-09-20T10:00:00Z',
        lifecycle: { type: 'buildpack', data: { buildpacks: ['nodejs_buildpack'], stack: 'cflinuxfs4' } },
        relationships: { space: { data: { guid: space.guid } } },
        metadata: { labels: {}, annotations: {} },
        links: links(base, `apps/${guid}`, ['space', 'processes', 'packages', 'environment_variables',
            'current_droplet', 'droplets', 'tasks', 'revisions', 'deployed_revisions', 'features']),
    };
}

/**
 * @param {object} options
 * @param {string[]} options.validTokens  bearer tokens the API accepts
 */
export async function startMockCf({ validTokens }) {
    const state = { connections: 0, requests: [] };
    const server = http.createServer();
    server.on('connection', () => state.connections++);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    const apps = [
        app(base, APP.guid, APP.name, SPACE),
        app(base, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'twin', SPACE),
        app(base, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'twin', OTHER_SPACE),
    ];
    const list = (resources, included) => ({
        pagination: {
            total_results: resources.length,
            total_pages: 1,
            first: { href: `${base}/v3/x?page=1` },
            last: { href: `${base}/v3/x?page=1` },
            next: null,
            previous: null,
        },
        resources,
        ...(included ? { included } : {}),
    });

    server.on('request', (req, res) => {
        const url = new URL(req.url, base);
        state.requests.push(`${req.method} ${url.pathname}${url.search}`);
        const send = (status, body, headers = {}) => {
            res.writeHead(status, { 'content-type': 'application/json', ...headers });
            res.end(body === undefined ? '' : JSON.stringify(body));
        };

        if (url.pathname === '/') {
            return send(200, { links: { self: { href: base }, log_cache: { href: base }, uaa: { href: base } } });
        }
        const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
        if (!validTokens.includes(token)) {
            return send(401, { errors: [{ code: 1000, title: 'CF-InvalidAuthToken', detail: 'Invalid Auth Token' }] });
        }

        const p = url.pathname;
        const q = url.searchParams;
        if (req.method === 'GET' && p === '/v3/apps') {
            let found = apps;
            if (q.get('names')) found = found.filter((a) => q.get('names').split(',').includes(a.name));
            if (q.get('space_guids')) found = found.filter((a) => q.get('space_guids').split(',').includes(a.relationships.space.data.guid));
            const included = q.get('include') ? { spaces: [SPACE, OTHER_SPACE], organizations: [ORG] } : undefined;
            return send(200, list(found, included));
        }
        if (req.method === 'POST' && p === '/v3/apps') {
            return send(422, { errors: [{ code: 10016, title: 'CF-UniquenessError', detail: "App with the name 'web-app' already exists." }] });
        }
        const appMatch = p.match(/^\/v3\/apps\/([^/]+)(\/.*)?$/);
        if (appMatch) {
            const found = apps.find((a) => a.guid === appMatch[1]);
            if (!found) return send(404, { errors: [{ code: 10010, title: 'CF-ResourceNotFound', detail: 'App not found' }] });
            const sub = appMatch[2] ?? '';
            if (req.method === 'GET' && sub === '') {
                return send(200, { ...found, included: { spaces: [SPACE], organizations: [ORG] } });
            }
            if (req.method === 'DELETE' && sub === '') {
                return send(202, undefined, { location: `${base}/v3/jobs/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee` });
            }
            if (req.method === 'POST' && /^\/actions\/(start|stop|restart)$/.test(sub)) {
                return send(200, { ...found, state: sub.endsWith('stop') ? 'STOPPED' : 'STARTED' });
            }
            if (sub === '/processes') {
                return send(200, list([{
                    guid: PROCESS_GUID, type: 'web', instances: 2, memory_in_mb: 256, disk_in_mb: 1024,
                    command: 'npm start', health_check: { type: 'port' }, links: links(base, `processes/${PROCESS_GUID}`, ['stats']),
                }]));
            }
            if (sub.startsWith('/routes')) {
                return send(200, list([{ guid: 'r1', url: 'web-app.cfapps.eu10.hana.ondemand.com', links: links(base, 'routes/r1') }]));
            }
            if (sub === '/droplets/current') {
                return send(200, { guid: 'dr1', state: 'STAGED', stack: 'cflinuxfs4', buildpacks: [{ name: 'nodejs_buildpack', version: '1.8.0' }], created_at: '2026-09-20T09:59:00Z' });
            }
        }
        if (p === `/v3/processes/${PROCESS_GUID}/stats`) {
            return send(200, { resources: [
                { index: 0, state: 'RUNNING', uptime: 3600, usage: { cpu: 0.0123, mem: 134217728, disk: 209715200 } },
                { index: 1, state: 'CRASHED', uptime: 0, usage: {}, details: 'exited with status 1' },
            ] });
        }
        if (p === '/v3/service_credential_bindings') {
            return send(200, list([{ guid: 'b1', type: 'app' }], { service_instances: [{ guid: 'si1', name: 'my-db', type: 'managed' }] }));
        }
        if (p === `/api/v1/read/${APP.guid}`) {
            const b64 = (s) => Buffer.from(s).toString('base64');
            return send(200, { envelopes: { batch: [
                { timestamp: '1790000002000000000', instance_id: '1', tags: { source_type: 'APP/PROC/WEB' }, log: { payload: b64('Error: connect ECONNREFUSED'), type: 'ERR' } },
                { timestamp: '1790000001000000000', instance_id: '0', tags: { source_type: 'APP/PROC/WEB' }, log: { payload: b64('listening on 8080'), type: 'OUT' } },
            ] } });
        }
        if (req.method === 'GET' && p.startsWith('/v3/')) {
            return send(200, list([]));
        }
        return send(404, { errors: [{ code: 10000, title: 'CF-NotFound', detail: 'Unknown request' }] });
    });

    return {
        url: base,
        state,
        close: () => new Promise((resolve) => {
            server.closeAllConnections();
            server.close(resolve);
        }),
    };
}
