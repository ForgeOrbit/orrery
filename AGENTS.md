# Orrery: notes for agents and contributors

Self-hosted project management for teams of humans and AI agents. Plans and decisions live in GitHub
issues labeled `need discussion` (#1 stack, #8 MVP overview). Don't build a feature before its
issue is agreed.

## Commands

Run from the repo root. Node 26 (`.node-version`) and pnpm 12 (`packageManager`).

| Command | Does |
| --- | --- |
| `pnpm install` | Install everything. Never use npm, yarn or bun to install. |
| `docker compose up -d postgres` | Start Postgres for development (needs `.env`, see `.env.example`). |
| `pnpm dev` | Server on :8080 (reloads on change) and web on :5173. |
| `pnpm check` | Format check, lint (type-aware), typecheck. Must pass before a commit. |
| `pnpm fix` | Format and apply lint fixes. |
| `pnpm test` | Unit tests and Postgres tests (Docker required, via Testcontainers). |
| `pnpm gen` | Regenerate `contract/*.json`. Run after changing a route or tool, and commit the result. |
| `docker compose up -d --build --wait` then `ORRERY_URL=http://localhost:8080 pnpm test:e2e` | Black-box tests against the real image. |

## Layout

| Path | What |
| --- | --- |
| `apps/server/src/service/` | Business rules. The only layer that decides anything. |
| `apps/server/src/transport/rest/` | REST routes: validate, call a service, map the result. No rules. |
| `apps/server/src/transport/mcp/` | MCP tools: same as REST, for agents. |
| `apps/server/src/db/` | Postgres client and the migration runner. |
| `apps/web/` | React SPA (Vite). Talks to the server over HTTP only. |
| `packages/contract/` | zod schemas shared by REST, MCP and web. MCP tool contracts live in `mcp-tools.ts`. |
| `contract/` | Generated OpenAPI 3.1 and MCP tool JSON Schemas. Don't edit by hand. |
| `db/migrations/` | Plain `.sql` files, applied in name order at startup. Never edit an applied file; add a new one. |
| `tests/e2e/` | Tests against a running server. They never import server code. |

## Rules

- **Portability.** The server may be rewritten in Go or Rust later. Keep these language-neutral:
  the generated contract, SQL migrations, data rules as Postgres constraints, env var names, port 8080,
  `/healthz` and `/readyz`, and the e2e tests.
- **Runtime contract.** Configuration only through env vars (`apps/server/src/config.ts`). Logs are JSON
  lines on stdout.
- **TypeScript runs directly in Node** (type stripping). Only erasable syntax: no `enum`, no
  `namespace`, no parameter properties. Import local files with their `.ts` extension.
- **No Bun-only or framework magic:** no decorators, no DI containers. Use Web-standard APIs where possible.
- **Await every promise.** `no-floating-promises` is an error, because a dropped database call is a
  silent race.
- **Test against real Postgres** for anything touching claims, leases or migrations. No database mocks.
