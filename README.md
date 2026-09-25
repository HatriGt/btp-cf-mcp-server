# BTP CF MCP Server

An MCP (Model Context Protocol) server for the Cloud Foundry V3 API on SAP BTP, powered by [odata-mcp-proxy](https://www.npmjs.com/package/odata-mcp-proxy). It exposes the CF V3 API as MCP tools, allowing AI assistants like Claude to manage your Cloud Foundry landscape through natural language.

The entire server is defined through a single JSON config file -- no custom code required.

## Quick Start (local, stdio)

You don't need a BTP deployment. Your MCP client runs the server from npm as a
local process, and it signs in to Cloud Foundry with your `cf` CLI login.

**Requires:** Node.js 20+ and the [cf CLI](https://github.com/cloudfoundry/cli).

1. Log in to Cloud Foundry once. The server refreshes the token after that.

   ```bash
   cf login -a https://api.cf.eu10.hana.ondemand.com --sso
   ```

2. Add the server to your MCP client.

   **Claude Code**

   ```bash
   claude mcp add btp-cf -- npx -y btp-cf-mcp-server
   ```

   **Claude Desktop** (`claude_desktop_config.json`), Cursor (`.cursor/mcp.json`) and similar clients:

   ```json
   {
     "mcpServers": {
       "btp-cf": {
         "command": "npx",
         "args": ["-y", "btp-cf-mcp-server"],
         "env": { "LOG_LEVEL": "warn" }
       }
     }
   }
   ```

   On macOS, Claude Desktop doesn't inherit your shell `PATH`. If it reports that
   `npx` or `cf` isn't found, use the full path to `npx` as `command` and add
   `"CF_CLI_PATH": "/opt/homebrew/bin/cf"` (from `which cf`) to `env`.

The tools act with the permissions of the CF user who is logged in.

### Authentication modes

Choose a mode with `CF_AUTH_MODE`:

| Mode | How it authenticates | Needs |
|------|----------------------|-------|
| `cli` (default) | Reuses your `cf login` session through `cf oauth-token` (works with `--sso`) | `cf` CLI logged in; the API endpoint comes from `cf target` unless `CF_API_URL` is set |
| `password` | OAuth2 password grant against CF UAA, using the public `cf` client | `CF_API_URL`, `CF_USERNAME`, `CF_PASSWORD` (a user without 2FA, such as a technical user) |
| `destination` | BTP Destination service, as in the hosted setup | a `default-env.json` with the service bindings in the package directory |

Example for password mode:

```json
"env": {
  "CF_AUTH_MODE": "password",
  "CF_API_URL": "https://api.cf.eu10.hana.ondemand.com",
  "CF_USERNAME": "tech-user@example.com",
  "CF_PASSWORD": "..."
}
```

Other optional variables:

| Variable | Purpose |
|----------|---------|
| `ENABLED_API_CATEGORIES` | Load only some tool categories, e.g. `apps-and-processes,orgs-and-spaces` (also: `services`, `networking`, `platform`, `quotas`) |
| `CF_API_URL` | Override the CF API endpoint |
| `CF_HOME` | Use a different cf CLI home directory |
| `CF_CLI_PATH` | Path to the `cf` binary |
| `LOG_LEVEL` | `error`, `warn`, `info` (default) or `debug`; logs go to stderr |
| `REQUEST_TIMEOUT` | Request timeout in ms (default 60000) |

### How the stdio launcher works

The package's `stdio.mjs`:
- starts `odata-mcp-proxy` with the stdio transport and sends all logs to stderr, so stdout carries only JSON-RPC
- loads the bundled `btp-cf-api-config.json`, whatever directory the client starts it from
- gets a CF UAA user token and gives it to the proxy as an SAP Cloud SDK environment destination, refreshing it before it expires

To run it from a clone instead of npm, use `npm install` and then `npm run start:stdio`,
or point your client at `node /absolute/path/to/stdio.mjs`.

## How It Works

This project uses the `odata-mcp-proxy` npm package, which maps OData/REST services to MCP tools based on a configuration file. You provide a config describing your APIs and entity sets, and the proxy generates the corresponding MCP tools automatically.

```
AI Assistant (Claude, Cursor, etc.)
        |
        | MCP Protocol (HTTP or stdio)
        v
  odata-mcp-proxy
        |
        | REST + OAuth2 (via BTP Destination Service)
        v
  Cloud Foundry V3 API
```

Think of it like the [SAP Application Router](https://www.npmjs.com/package/@sap/approuter) -- a ready-made runtime you configure, not code you write.

## Exposed CF V3 APIs

The config file (`btp-cf-api-config.json`) exposes the Cloud Foundry V3 API, organized by category:

### Apps & Processes

| Tool | Operations | Description |
|------|-----------|-------------|
| `Apps` | list, get, create, update, delete | Deploy, manage, start, and stop CF applications |
| `Builds` | list, get, create | Stage a package into a droplet |
| `Deployments` | list, get, create | Rolling deployments and canary releases |
| `Droplets` | list, get, delete | Staged, runnable artifacts produced from builds |
| `Packages` | list, get, create, delete | Application source code or Docker images for staging |
| `Processes` | list, get, update | Running instances of an app (web, worker, etc.) |
| `Tasks` | list, get, create | One-off processes like database migrations or batch jobs |

### Orgs & Spaces

| Tool | Operations | Description |
|------|-----------|-------------|
| `Organizations` | list, get, create, update, delete | Top-level containers for spaces, apps, and users |
| `Spaces` | list, get, create, update, delete | Subdivisions within an org for deploying apps and services |
| `Roles` | list, get, create, delete | User role assignments (OrgManager, SpaceDeveloper, etc.) |
| `Users` | list, get, create, update, delete | User accounts in the CF deployment |

### Services

| Tool | Operations | Description |
|------|-----------|-------------|
| `ServiceInstances` | list, get, create, update, delete | Provisioned instances of marketplace services |
| `ServiceCredentialBindings` | list, get, create, update, delete | Service keys and app bindings for accessing service instances |
| `ServiceOfferings` | list, get, update, delete | Services available in the marketplace |
| `ServicePlans` | list, get, update, delete | Pricing/feature tiers for each service offering |
| `ServiceBrokers` | list, get, create, update, delete | Broker applications that advertise and provision services |
| `ServiceRouteBindings` | list, get, create, delete | Bind a service instance to a route for request interception |
| `ServiceUsageEvents` | list, get | Historical record of service instance events for billing/auditing |

### Networking

| Tool | Operations | Description |
|------|-----------|-------------|
| `Domains` | list, get, create, update, delete | Shared or private domain names used to create routes |
| `Routes` | list, get, create, update, delete | URL mappings that direct traffic to apps |
| `SecurityGroups` | list, get, create, update, delete | Egress firewall rules controlling outbound app connectivity |

### Platform

| Tool | Operations | Description |
|------|-----------|-------------|
| `Buildpacks` | list, get, create, update, delete | Runtimes and frameworks for staging applications |
| `FeatureFlags` | list, get, update | Platform-level toggles for CF features |
| `Stacks` | list, get, create, update, delete | Root filesystems (OS base images) for running apps |
| `IsolationSegments` | list, get, create, update, delete | Dedicated compute pools for running apps in isolated Diego cells |
| `Jobs` | get | Track status of long-running async operations |

### Quotas

| Tool | Operations | Description |
|------|-----------|-------------|
| `OrganizationQuotas` | list, get, create, update, delete | Resource limits (memory, instances, routes, services) for orgs |
| `SpaceQuotas` | list, get, create, update, delete | Resource limits for individual spaces within an org |

All `_list` tools support query parameters for filtering and pagination (`page`, `per_page`, and entity-specific filters).

## Prerequisites

- **Node.js** 18+ (20+ recommended)
- **SAP BTP account** with a Cloud Foundry environment
- **BTP Destination** configured for the CF V3 API (`CF_API`) with OAuth2 authentication
- **Cloud Foundry CLI** (`cf`) and **MBT Build Tool** (`mbt`) for deployment

## Project Structure

```
btp-cf-mcp-server/
├── package.json              # Start script + odata-mcp-proxy dependency
├── stdio.mjs                 # Local stdio launcher (npm bin: btp-cf-mcp-server)
├── btp-cf-api-config.json    # API configuration (defines all MCP tools)
├── mta.yaml                  # BTP Cloud Foundry deployment descriptor
├── xs-security.json          # XSUAA OAuth2 configuration
├── default-env.json          # Local dev credentials (gitignored)
└── LICENSE
```

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure BTP destination

Create a BTP Destination pointing to the Cloud Foundry V3 API:

| Destination | URL |
|-------------|-----|
| `CF_API` | `https://api.cf.<region>.hana.ondemand.com` |

The destination should use OAuth2 client credentials authentication.

### 3. Local development

Create a `default-env.json` with your BTP service bindings (XSUAA, Destination, Connectivity) to run locally:

```bash
npm start
```

This runs `odata-mcp-proxy --config btp-cf-api-config.json`.

### 4. Deploy to BTP

```bash
npm run build:btp     # Build MTA archive
npm run deploy:btp    # Deploy to Cloud Foundry
```

The MTA deployment provisions three service instances:
- **Destination** (lite) -- resolves the CF API endpoint and manages OAuth2 tokens
- **Connectivity** (lite) -- enables secure backend connectivity
- **XSUAA** (application) -- handles OAuth2 authentication with role-based access control

## Security

The XSUAA configuration (`xs-security.json`) defines three role templates:

| Role | Scopes | Description |
|------|--------|-------------|
| `MCPViewer` | read | Read-only access |
| `MCPEditor` | read, write | Read and write access |
| `MCPAdmin` | read, write, admin | Full administrative access |

OAuth2 redirect URIs are pre-configured for Claude.ai, Cursor, Microsoft Teams, and local development.

## Creating Your Own MCP Server

This project demonstrates how easy it is to create a custom MCP server using `odata-mcp-proxy`. To build your own:

1. Create a new project and install the dependency:
   ```bash
   mkdir my-mcp-server && cd my-mcp-server
   npm init -y
   npm install odata-mcp-proxy
   ```

2. Add a start script to `package.json`:
   ```json
   {
     "scripts": {
       "start": "odata-mcp-proxy --config my-api-config.json"
     }
   }
   ```

3. Define your APIs in a config file (`my-api-config.json`):
   ```json
   {
     "server": {
       "name": "my-mcp-server",
       "version": "1.0.0",
       "description": "My custom MCP server"
     },
     "apis": [
       {
         "name": "my-api",
         "destination": "MY_BTP_DESTINATION",
         "pathPrefix": "/api/v1",
         "csrfProtected": true,
         "entitySets": [
           {
             "entitySet": "Products",
             "description": "Product catalog",
             "category": "master-data",
             "keys": [{ "name": "Id", "type": "string" }],
             "operations": { "list": true, "get": true, "create": false, "update": false, "delete": false }
           }
         ]
       }
     ]
   }
   ```

4. Add your `mta.yaml`, `xs-security.json`, and BTP Destinations, then deploy. That's it -- no code to write.

## License

MIT
