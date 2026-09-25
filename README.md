# BTP MCP Server

[![npm version](https://img.shields.io/npm/v/btp-mcp-server.svg)](https://www.npmjs.com/package/btp-mcp-server)
[![CI](https://github.com/HatriGt/btp-cf-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/HatriGt/btp-cf-mcp-server/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that gives AI assistants access to the
**Cloud Foundry V3 API on SAP BTP**. It lets you inspect, troubleshoot and manage your CF landscape by asking in
plain language: apps, processes, services, routes, orgs, spaces, quotas and more.

It runs locally as a stdio server and signs in with your existing `cf login`, so there's nothing to deploy and no
BTP services to provision. You can also host it on BTP Cloud Foundry for a team.

```text
You:     Why is web-app in my dev space not starting?
Claude:  → CF_AppSummary { app: "web-app" }        1 of 2 instances CRASHED ("exited with status 1")
         → CF_AppRecentLogs { app: "web-app", errors_only: true }
           Error: connect ECONNREFUSED 10.0.2.15:5432
         The app crashes on startup because it can't reach its PostgreSQL database. The service
         instance "my-db" is bound, but …
```

---

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Client setup](#client-setup)
- [Tools](#tools)
- [Authentication](#authentication)
- [Configuration reference](#configuration-reference)
- [How it works](#how-it-works)
- [Hosting on SAP BTP](#hosting-on-sap-btp)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Security](#security)
- [Acknowledgements](#acknowledgements)
- [License](#license)

---

## Features

- **Zero-setup local mode.** Reuses your `cf login` session, including SSO, and refreshes the token automatically.
- **The full CF V3 API.** 28 resource types across apps, services, networking, orgs and spaces, platform and quotas.
- **Task-level tools.** `CF_AppSummary` (like `cf app`) and `CF_AppRecentLogs` (like `cf logs --recent`) answer
  common questions in one call and accept app names as well as GUIDs.
- **Context-efficient.** Progressive tool discovery exposes 34 tools instead of 120, and responses are compacted
  (about 74% smaller for typical list results).
- **Fast.** Starts in about 0.4 s, pools HTTP connections, and fetches independent resources in parallel.
- **Clear errors.** CF error titles and details reach the model, so it can correct itself. Asynchronous operations
  return the job URL to poll.
- **Local or hosted.** Run it as a local stdio process, or deploy it to BTP Cloud Foundry with XSUAA-protected HTTP.

## Quick start

**Prerequisites:** [Node.js](https://nodejs.org) 20 or later and the
[Cloud Foundry CLI](https://github.com/cloudfoundry/cli#downloads).

**1. Log in to Cloud Foundry.** Do this once; the server keeps the session fresh after that.

```bash
cf login -a https://api.cf.eu10.hana.ondemand.com --sso
cf target -o <org> -s <space>     # optional: sets the default space for app names
```

**2. Add the server to your MCP client.** For example, in Claude Code:

```bash
claude mcp add btp-cf -- npx -y btp-mcp-server
```

**3. Ask a question.** For example: *"List the apps in my space and their state"* or *"Which service instances
have no bindings?"*

## Client setup

All clients start the server the same way: the command `npx -y btp-mcp-server`, with optional
[environment variables](#configuration-reference).

<details open>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add btp-cf -- npx -y btp-mcp-server

# with options
claude mcp add btp-cf -e CF_TOOLS=all -- npx -y btp-mcp-server
```

</details>

<details>
<summary><b>Claude Desktop</b></summary>

Edit `claude_desktop_config.json` (**Settings → Developer → Edit Config**):

```json
{
  "mcpServers": {
    "btp-cf": {
      "command": "npx",
      "args": ["-y", "btp-mcp-server"]
    }
  }
}
```

On macOS, Claude Desktop doesn't inherit your shell's `PATH`. If `npx` or `cf` can't be found, use absolute paths:
set `"command"` to the output of `which npx`, and add `"env": { "CF_CLI_PATH": "/opt/homebrew/bin/cf" }`.

</details>

<details>
<summary><b>Cursor</b></summary>

Add to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per project):

```json
{
  "mcpServers": {
    "btp-cf": {
      "command": "npx",
      "args": ["-y", "btp-mcp-server"]
    }
  }
}
```

</details>

<details>
<summary><b>VS Code (GitHub Copilot)</b></summary>

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "btp-cf": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "btp-mcp-server"]
    }
  }
}
```

</details>

<details>
<summary><b>Faster startup: global install</b></summary>

`npx` checks the registry on each launch. For the fastest startup, install globally and use the binary directly:

```bash
npm install -g btp-mcp-server
claude mcp add btp-cf -- btp-mcp-server
```

</details>

## Tools

### Cloud Foundry tools

Task-oriented tools that combine several API calls. Tools that take an `app` accept a name or a GUID. Names are
resolved in `space_guid` if you pass one, and otherwise in the space targeted with `cf target`.

| Tool | Description |
|------|-------------|
| `CF_Target` | The API endpoint, the signed-in user, and the targeted org and space, with GUIDs |
| `CF_AppSummary` | State, org and space, instances with live CPU, memory and disk usage, routes, bound services, buildpacks and stack. Everything is fetched in parallel |
| `CF_AppRecentLogs` | Recent logs from log-cache, optionally filtered to stderr or by a search term |
| `CF_AppAction` | Start, stop or restart an app |

### API tools

Every CF V3 resource is available with its list, get, create, update and delete operations, as the API permits.
Only the most used resources are registered as individual tools (`Apps_list`, `Spaces_get`, …). Everything else
goes through two stable meta-tools:

| Tool | Description |
|------|-------------|
| `search_operations` | Find resources by keyword (for example "service keys" or "quotas") and get their operations, keys and path examples |
| `execute_operation` | Run an operation on any resource |

Set `CF_TOOLS=all` to register every operation as its own tool instead. See [Tool modes](#tool-modes).

| Category | Resources |
|----------|-----------|
| `apps-and-processes` | Apps, Builds, Deployments, Droplets, Packages, Processes, Tasks |
| `orgs-and-spaces` | Organizations, Spaces, Roles, Users |
| `services` | ServiceInstances, ServiceCredentialBindings, ServiceOfferings, ServicePlans, ServiceBrokers, ServiceRouteBindings, ServiceUsageEvents |
| `networking` | Domains, Routes, SecurityGroups |
| `platform` | Buildpacks, FeatureFlags, Stacks, IsolationSegments, Jobs |
| `quotas` | OrganizationQuotas, SpaceQuotas |

Paths follow CF V3 REST conventions: `/<guid>` addresses a single resource, and lists take query parameters such as
`?names=a,b&space_guids=<guid>&per_page=50&page=2&order_by=-created_at`. Actions are POSTs, for example
`/<guid>/actions/restart` on Apps or `/<guid>/actions/scale` on Processes.

### Tool modes

| `CF_TOOLS` | Registered tools | Count |
|------------|------------------|------:|
| `hybrid` (default) | Individual tools for `CF_PINNED_TOOLS`, plus the meta-tools and the CF tools | 34 |
| `search` | Only the meta-tools and the CF tools | 6 |
| `all` | Every operation as its own tool, plus the CF tools | 120 |

Hybrid mode stays under the tool limits of clients such as Cursor, and it keeps tool definitions from taking up the
model's context. The tool list never changes during a session, which keeps prompt caching effective.

## Authentication

The tools act with the permissions of the Cloud Foundry user whose token is used. Choose how the token is obtained
with `CF_AUTH_MODE`:

| Mode | How it works | Use when |
|------|--------------|----------|
| `cli` (default) | Uses the access token cached by the cf CLI while it is valid. When it expires, runs `cf oauth-token`, which refreshes it and keeps the CLI session in sync. | Working interactively. Supports SSO (`cf login --sso`). |
| `password` | OAuth2 password grant against the CF UAA with the public `cf` client, refreshed with the refresh token. Needs `CF_API_URL`, `CF_USERNAME` and `CF_PASSWORD`. | Automation or a technical user without 2FA. |
| `destination` | Resolves the `CF_API` destination through the BTP Destination service, like the hosted deployment. Needs a `default-env.json` with the service bindings in the package directory. | Reusing an existing BTP destination. |

If a request is rejected with `401`, the server gets a fresh token and retries once. This covers tokens that were
revoked or rotated during a session.

Example for password mode:

```json
"env": {
  "CF_AUTH_MODE": "password",
  "CF_API_URL": "https://api.cf.eu10.hana.ondemand.com",
  "CF_USERNAME": "cf-automation@example.com",
  "CF_PASSWORD": "<password>"
}
```

## Configuration reference

All settings are environment variables.

| Variable | Default | Description |
|----------|---------|-------------|
| `CF_AUTH_MODE` | `cli` | `cli`, `password` or `destination`. See [Authentication](#authentication) |
| `CF_API_URL` | `cf target` endpoint | CF API endpoint, e.g. `https://api.cf.eu10.hana.ondemand.com`. Required in `password` mode |
| `CF_USERNAME` / `CF_PASSWORD` | – | Credentials for `password` mode |
| `CF_HOME` | home directory | cf CLI home, for when you keep several CLI configurations |
| `CF_CLI_PATH` | `cf` | Path to the cf binary |
| `CF_SPACE_GUID` | – | Default space for resolving app names when no space is targeted with the cf CLI |
| `CF_TOOLS` | `hybrid` | `hybrid`, `search` or `all`. See [Tool modes](#tool-modes) |
| `CF_PINNED_TOOLS` | `Apps,Processes,Spaces,Organizations,ServiceInstances,Routes` | Resources registered as individual tools in hybrid mode |
| `CF_COMPACT` | `true` | Removes per-resource `links` and empty `metadata` from responses. Set to `false` for raw CF responses |
| `ENABLED_API_CATEGORIES` | `all` | Comma-separated [categories](#api-tools) to expose, e.g. `apps-and-processes,services` |
| `REQUEST_TIMEOUT` | `60000` | Request timeout in milliseconds |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug`. Logs go to stderr |

## How it works

```text
┌────────────────┐  stdio (JSON-RPC)  ┌──────────────────────────────────────────┐  HTTPS  ┌──────────────────┐
│   MCP client   │ ◄────────────────► │ btp-mcp-server                        │ ──────► │ CF V3 API        │
│ Claude, Cursor │                    │  ├ odata-mcp-proxy  (tools, discovery)   │         │ log-cache        │
└────────────────┘                    │  ├ CF client  (keep-alive, retries,      │         └──────────────────┘
                                      │  │             errors, compaction)       │  token  ┌──────────────────┐
                                      │  └ token provider (cf CLI / UAA)         │ ◄────── │ cf CLI / CF UAA  │
                                      └──────────────────────────────────────────┘         └──────────────────┘
```

The server is built on [odata-mcp-proxy](https://www.npmjs.com/package/odata-mcp-proxy), which turns the
declarative API description in [`btp-cf-api-config.json`](btp-cf-api-config.json) into MCP tools. The stdio entry
point ([`stdio.mjs`](stdio.mjs)) adds what a local Cloud Foundry setup needs:

| Module | Responsibility |
|--------|----------------|
| [`lib/auth.mjs`](lib/auth.mjs) | Gets a UAA token from the cf CLI cache, `cf oauth-token` or a password grant, and refreshes it before it expires |
| [`lib/cf-client.mjs`](lib/cf-client.mjs) | CF-aware HTTP client: connection pooling, one retry with a fresh token after a 401, backoff on 429 and 5xx for idempotent requests, CF error details, job URLs for 202 responses, and response compaction |
| [`lib/tools.mjs`](lib/tools.mjs) | The `CF_*` tools, app name resolution, and parallel fetching |

stdout is reserved for the MCP protocol; all logging goes to stderr.

**Performance**, measured against a local mock CF API:

| | Before | After |
|---|---|---|
| Time to first response on startup | ~850 ms | ~430 ms. The cached token is used without spawning `cf`, and loading the proxy overlaps with getting the token |
| Connections for 28 API calls | 28 (new TLS handshake per call) | 5 (pooled) |
| 50-app list response | 106 KB | 28 KB (−74%) |
| "What's wrong with my app?" | 5+ sequential tool calls | 1–2 calls (`CF_AppSummary`, `CF_AppRecentLogs`) |

## Hosting on SAP BTP

The same configuration can be deployed as a shared, XSUAA-protected HTTP MCP server on SAP BTP Cloud Foundry.

1. Create a BTP destination named `CF_API` that points to your CF API endpoint
   (`https://api.cf.<region>.hana.ondemand.com`) and uses OAuth2 authentication.
2. Build and deploy the MTA. It provisions the Destination, Connectivity and XSUAA (`application` plan) services:

   ```bash
   npm install
   npm run build:btp     # mbt build
   npm run deploy:btp    # cf deploy mta_archives/btp-cf-mcp-server_1.0.0.mtar
   ```

3. Assign one of the role templates from [`xs-security.json`](xs-security.json) through role collections:

   | Role template | Scopes |
   |---------------|--------|
   | `MCPViewer` | `read` |
   | `MCPEditor` | `read`, `write` |
   | `MCPAdmin` | `read`, `write`, `admin` |

4. Connect your client to `https://<app-route>/mcp`. OAuth redirect URIs for Claude, Cursor, Microsoft Teams and
   local tooling are pre-configured in `xs-security.json`.

The hosted server uses `odata-mcp-proxy` directly (`npm start`). The stdio-only features, such as the `CF_*` tools,
discovery mode and the CF client, apply to local use.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `CF API endpoint unknown` | Run `cf login -a <api-endpoint>`, or set `CF_API_URL` |
| `cf CLI not found` | Install the cf CLI, or set `CF_CLI_PATH` to its absolute path. Claude Desktop on macOS needs this |
| `cf oauth-token failed … Run cf login` | Your CLI session expired. Run `cf login` again |
| `No app named "x" in space …` | Target the right space with `cf target -s <space>`, or pass `space_guid` |
| The client doesn't list the tools you expect | Check `CF_TOOLS`. In the default hybrid mode, less-used resources are reached through `search_operations` / `execute_operation` |
| The server doesn't start in the client | Run `npx -y btp-mcp-server` in a terminal. Startup errors are printed to stderr |
| You need more detail | Set `LOG_LEVEL=debug` and check the client's MCP log |

## Development

```bash
git clone https://github.com/HatriGt/btp-cf-mcp-server.git
cd btp-cf-mcp-server
npm install
npm test               # end-to-end tests against a mock CF API
npm run start:stdio    # run the stdio server from source
```

To use your local checkout in a client, point it at `node /absolute/path/to/btp-cf-mcp-server/stdio.mjs`.

```text
btp-cf-mcp-server/
├── stdio.mjs                 # stdio entry point (npm bin: btp-mcp-server)
├── lib/
│   ├── auth.mjs              # UAA token provider
│   ├── cf-client.mjs         # CF V3 HTTP client
│   └── tools.mjs             # CF_* tools
├── btp-cf-api-config.json    # CF V3 resources exposed as MCP tools
├── test/                     # mock CF API + end-to-end tests (node:test)
├── mta.yaml                  # BTP deployment descriptor
└── xs-security.json          # XSUAA configuration for the hosted server
```

**Adding a CF resource:** add an entry to `apis[0].entitySets` in `btp-cf-api-config.json`, with its `urlPath`,
`keys`, `category`, the allowed `operations`, and a description that includes the filter parameters. It is picked up
by the individual tools and by discovery.

**Releasing:** bump `version` in `package.json`, then publish a GitHub release tagged `v<version>`. The
[publish workflow](.github/workflows/publish.yml) runs the tests and publishes to npm with provenance. It needs an
`NPM_TOKEN` repository secret.

## Security

- The server can **change and delete** resources: apps, services, routes, spaces, orgs and more, within the
  permissions of the CF user. Use a user with the minimum roles you need, for example `SpaceAuditor` for read-only
  work. Review destructive tool calls before approving them in your client.
- Tokens are held in memory and never written to disk. In `cli` mode, `cf oauth-token` updates the CLI's own config,
  as the CLI does when you use it.
- Don't commit `default-env.json` or credentials. Pass `CF_PASSWORD` through your client's secret handling where
  possible.

## Acknowledgements

Built on [odata-mcp-proxy](https://www.npmjs.com/package/odata-mcp-proxy) by Wouter Lemaire. The CF V3 API
configuration originates from [lemaiwo/btp-cf-mcp-server](https://github.com/lemaiwo/btp-cf-mcp-server).

## License

[MIT](LICENSE)
