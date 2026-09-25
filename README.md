# BTP CF MCP Server

An MCP (Model Context Protocol) server for the Cloud Foundry V3 API on SAP BTP, powered by [odata-mcp-proxy](https://www.npmjs.com/package/odata-mcp-proxy). It exposes the CF V3 API as MCP tools, allowing AI assistants like Claude to manage your Cloud Foundry landscape through natural language.

The entire server is defined through a single JSON config file -- no custom code required.

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

### 4. Run locally over stdio (no hosting)

Instead of deploying to BTP, you can let your MCP client spawn the server as a
local process. `stdio.mjs` wraps `odata-mcp-proxy` for this:

- forces the stdio transport and sends all logs to stderr, so stdout carries only JSON-RPC
- finds `btp-cf-api-config.json` next to itself, whatever the client's working directory
- gets a Cloud Foundry UAA user token locally and refreshes it before it expires, so no BTP Destination, XSUAA or Connectivity service is needed

Pick an auth mode with `CF_AUTH_MODE`:

| Mode | How it authenticates | Needs |
|------|----------------------|-------|
| `cli` (default) | Reuses your `cf login` session via `cf oauth-token` (works with `cf login --sso`) | `cf` CLI logged in; API endpoint taken from `cf target` unless `CF_API_URL` is set |
| `password` | OAuth2 password grant against CF UAA (public `cf` client) | `CF_API_URL`, `CF_USERNAME`, `CF_PASSWORD` (user without 2FA) |
| `destination` | Uses the BTP Destination service like the hosted app | `default-env.json` next to `stdio.mjs` with the service bindings |

Log in once and check it works:

```bash
npm install
cf login -a https://api.cf.eu10.hana.ondemand.com --sso
npm run start:stdio   # waits for JSON-RPC on stdin; Ctrl+C to exit
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "btp-cf": {
      "command": "node",
      "args": ["/absolute/path/to/btp-cf-mcp-server/stdio.mjs"],
      "env": {
        "LOG_LEVEL": "warn"
      }
    }
  }
}
```

Claude Desktop does not inherit your shell `PATH` on macOS. If it can't find `cf`,
add `"CF_CLI_PATH": "/opt/homebrew/bin/cf"` (from `which cf`) to `env`.

**Claude Code**:

```bash
claude mcp add btp-cf -- node /absolute/path/to/btp-cf-mcp-server/stdio.mjs
```

**Password mode** (for example, a technical user):

```json
"env": {
  "CF_AUTH_MODE": "password",
  "CF_API_URL": "https://api.cf.eu10.hana.ondemand.com",
  "CF_USERNAME": "tech-user@example.com",
  "CF_PASSWORD": "..."
}
```

Other optional variables: `ENABLED_API_CATEGORIES` (for example, `apps-and-processes,orgs-and-spaces`),
`REQUEST_TIMEOUT`, `LOG_LEVEL`, `CF_HOME`.

The MCP tools act with the permissions of the CF user whose token is used.

### 5. Deploy to BTP

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
