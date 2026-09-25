// =============================================================================
// Cloud Foundry V3 HTTP client
//
// Replaces odata-mcp-proxy's SAP Cloud SDK transport for the CF API when the
// launcher holds the token itself:
//   - keep-alive connection pooling (the SDK opens a new TLS connection per call)
//   - CF error details ({"errors":[{title, detail}]}) instead of a bare status
//   - 202 Accepted responses expose the async job URL from the Location header
//   - one transparent retry with a fresh token on 401, and backoff on 429/5xx
//     for idempotent requests
// =============================================================================

const RETRYABLE = new Set([429, 502, 503, 504]);
const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);
const MAX_RETRIES = 2;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class CfApiError extends Error {
    constructor(status, body) {
        const errors = Array.isArray(body?.errors) ? body.errors : [];
        const details = errors.map((e) => [e.title, e.detail].filter(Boolean).join(': ')).filter(Boolean);
        const text = typeof body === 'string' && body ? `: ${body.slice(0, 500)}` : '';
        super(`CF API request failed with HTTP ${status}${details.length ? ` - ${details.join('; ')}` : text}`);
        this.name = 'CfApiError';
        this.status = status;
        this.errors = errors;
    }
}

/**
 * Remove data that costs tokens without helping the model: per-resource
 * `links` (absolute URLs that duplicate `relationships` GUIDs) and empty
 * `metadata`. Pagination links are kept so the model can page.
 */
export function compact(value) {
    if (Array.isArray(value)) return value.map(compact);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        if (k === 'links') continue;
        if (k === 'metadata' && isEmptyMetadata(v)) continue;
        out[k] = k === 'pagination' ? v : compact(v);
    }
    return out;
}

function isEmptyMetadata(metadata) {
    return metadata && typeof metadata === 'object' &&
        Object.values(metadata).every((v) => v && typeof v === 'object' && Object.keys(v).length === 0);
}

async function readBody(res) {
    const raw = await res.text();
    if (!raw) return undefined;
    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
}

/**
 * @param {object} options
 * @param {string} options.apiUrl     CF API endpoint, e.g. https://api.cf.eu10.hana.ondemand.com
 * @param {{get(): Promise<string>, refresh(): Promise<string>}} options.tokens
 * @param {number} [options.timeout]  request timeout in ms
 * @param {boolean} [options.compactResponses]
 */
export function createCfClient({ apiUrl, tokens, timeout = 60000, compactResponses = true }) {
    const base = apiUrl.replace(/\/+$/, '');
    const compactIf = (data) => (compactResponses ? compact(data) : data);

    /**
     * Send a request. `path` is relative to the API root (e.g. "/v3/apps?names=x")
     * or an absolute URL on the CF API (e.g. a job Location header).
     */
    async function request(method, path, { body, headers } = {}) {
        const upper = method.toUpperCase();
        const url = /^https?:\/\//.test(path) ? path : `${base}${path.startsWith('/') ? '' : '/'}${path}`;
        let token = await tokens.get();
        let refreshed = false;

        for (let attempt = 0; ; attempt++) {
            const res = await fetch(url, {
                method: upper,
                headers: {
                    accept: 'application/json',
                    authorization: `Bearer ${token}`,
                    ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
                    ...headers,
                },
                body: body !== undefined ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(timeout),
            });

            if (res.status === 401 && !refreshed) {
                await res.body?.cancel();
                token = await tokens.refresh();
                refreshed = true;
                continue;
            }
            if (RETRYABLE.has(res.status) && IDEMPOTENT.has(upper) && attempt < MAX_RETRIES) {
                await res.body?.cancel();
                const retryAfter = Number(res.headers.get('retry-after'));
                await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : 500 * 2 ** attempt);
                continue;
            }

            const data = await readBody(res);
            if (!res.ok) throw new CfApiError(res.status, data);

            if (res.status === 202) {
                const location = res.headers.get('location');
                const job = location ? { job: location, hint: 'Asynchronous operation; poll the job with Jobs_get until state is COMPLETE or FAILED.' } : {};
                return { accepted: true, ...job, ...(data && typeof data === 'object' ? compactIf(data) : {}) };
            }
            return data === undefined ? undefined : compactIf(data);
        }
    }

    return {
        request,
        get: (path) => request('GET', path),
        post: (path, body) => request('POST', path, { body }),
    };
}

/**
 * Make an odata-mcp-proxy ODataClient send its requests through the CF client.
 * All generated tools and the discovery executor call `client.execute()`.
 */
export function routeProxyClient(proxyClient, cfClient) {
    if (proxyClient.__cfRouted) return;
    const prefix = proxyClient.pathPrefix ?? '';
    proxyClient.execute = (method, path, body, extraHeaders) =>
        cfClient.request(method, `${prefix}/${path}`, { body, headers: extraHeaders });
    proxyClient.__cfRouted = true;
}

/** Only compact responses of an ODataClient that keeps using the SAP Cloud SDK. */
export function compactProxyClient(proxyClient) {
    if (proxyClient.__cfCompacted) return;
    const execute = proxyClient.execute.bind(proxyClient);
    proxyClient.execute = async (...args) => compact(await execute(...args));
    proxyClient.__cfCompacted = true;
}
