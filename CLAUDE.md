# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                                 # Install all dependencies (includes subprojects)
npm run build                               # Build both projects with nx
npm run typecheck                           # tsc --noEmit in both projects
npm test                                    # Jest in mcp-server and firefox-extension
npm run check-versions                      # All version numbers must agree
npm run lint --prefix firefox-extension     # web-ext lint (needs a build first)
npm run package --prefix firefox-extension  # web-ext build
cd mcp-server && npm start                  # Start the MCP server
cd mcp-server && npm run pack-dxt           # Package the Claude Desktop extension
```

## Architecture

Monorepo with three parts:

1. **mcp-server**: Node MCP server (stdio) that talks to the extension over a WebSocket it hosts on loopback.
2. **firefox-extension**: Firefox MV2 extension that executes commands, enforcing the user's access policy.
3. **common**: Type-only wire protocol (`common/protocol.ts`). Keep it free of runtime values: the server is compiled by plain tsc and must not pull these sources into its build.

### Protocol
- `Commands` in `common/protocol.ts` maps each command to its params and result.
- Server sends `{ type: "request", id, cmd, params }`; the extension answers `{ type: "response", id, ok, result | error, code }`. The extension opens with a `hello` carrying its protocol version.
- Every frame is `{ payload, signature }`, HMAC-SHA256 of the JSON payload with the shared secret, in both directions. The server only accepts a connection after a valid hello.
- Bump `ProtocolVersion` (and both `PROTOCOL_VERSION` constants) on incompatible changes.

### Adding a command
1. Add it to `Commands` in `common/protocol.ts`.
2. Implement the handler in `firefox-extension/handlers/*.ts`, calling `access.requireTab/requireTabs/requireGroup/requireUrl` before touching anything.
3. Map it to a tool category in `COMMAND_CATEGORY` (`firefox-extension/extension-config.ts`).
4. Register the MCP tool in `mcp-server/tools/*.ts` (with annotations) and list it in `mcp-server/manifest.json` (a test checks they match).

### Key files
- `mcp-server/browser-api.ts`: WebSocket server, request/response matching, timeouts, reconnects
- `mcp-server/tools/`: MCP tool definitions and output formatting
- `firefox-extension/acl/policy.ts`: policy language parser and evaluator (pure, unit tested)
- `firefox-extension/access.ts`: applies the policy to real tabs, groups and URLs; Firefox permission checks
- `firefox-extension/message-handler.ts`: dispatch, pause/tool switches, audit log
- `firefox-extension/handlers/`: command implementations
- `firefox-extension/page/`: functions injected into pages; must be self-contained (they are sent as source text)
- `firefox-extension/state/`: approvals, agent tabs, activity feed, toolbar badge
- `firefox-extension/background.ts`, `popup.ts`, `options.ts`: entry points

### Configuration
The extension generates a secret on install; the server needs it as `EXTENSION_SECRET`. Port 8089 by default (`EXTENSION_PORT`; the extension can connect to several ports). Config lives in `browser.storage.local` under `config`, the audit log under `auditLog`.

### Development notes
- esbuild bundles the extension; Jest (ts-jest, jsdom) tests it with the mocked `browser` in `__tests__/setup.ts`, whose storage is a real in-memory store.
- Server tests run a real WebSocket server against a fake extension, and the tools through an in-memory MCP client.
- Tab groups need Firefox 139+.
