<!-- intent-skills:start -->
## Skill Loading

Use the repository’s installed Intent. If it is unavailable, report the missing dependency instead of downloading a replacement.
Before editing files for a substantial task:
- Run `pnpm exec intent list` from the workspace root to see available local skills.
- If a listed skill matches the task, run `pnpm exec intent load <package>#<skill>` before changing files.
- Use the loaded `SKILL.md` guidance while making the change.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.
<!-- intent-skills:end -->

# Orrery: notes for agents and contributors

Self-hosted project management for teams of humans and AI agents. Plans and decisions live in GitHub
issues labeled `need discussion` (#1 stack, #8 MVP overview). Don't build a feature before its
issue is agreed.

## Commands

Run from the repo root. Node 26 (`.node-version`) and pnpm 12 (`packageManager`).

| Command | Does |
| --- | --- |
| `pnpm install` | Install everything, and the git hooks (lefthook). Never use npm, yarn or bun to install. |
| `docker compose up -d postgres` | Start Postgres for development (needs `.env`, see `.env.example`). |
| `pnpm dev` | Server on :8080 (reloads on change) and web on :5173. |
| `pnpm check` | Format check, lint (type-aware), typecheck. Must pass before a commit. |
| `pnpm fix` | Format and apply lint fixes. |
| `pnpm test` | Unit tests and Postgres tests (Docker required, via Testcontainers). |
| `pnpm gen` | Regenerate `contract/*.json`. Run after changing a route or tool, and commit the result. |
| `docker compose up -d --build --wait` then `ORRERY_URL=http://localhost:8080 pnpm test:e2e` | Black-box tests against the real image. |

## Layout

Code is organized by feature. One feature lives in one folder, on the server and in the web app.

| Path | What |
| --- | --- |
| `apps/server/src/features/<name>/` | One feature: `service.ts` (the only file that decides anything), `rest.ts` and `mcp.ts` (thin: validate, call the service, map the result), `*.test.ts`, and `index.ts`, its public interface. |
| `apps/server/src/features/index.ts` | The feature registry. Add every new feature here. |
| `apps/server/src/platform/` | Shared infrastructure: config, logging, database, migrations, HTTP app, MCP endpoint, OpenAPI. Knows nothing about features. |
| `apps/web/src/routes/` | Pages, one file per route (TanStack Router, file-based). |
| `apps/web/src/features/<name>/` | Queries and components a feature's pages share, with an `index.ts`. |
| `packages/contract/` | zod schemas shared by REST, MCP and web. MCP tool contracts live in `mcp-tools.ts`. |
| `contract/` | Generated OpenAPI 3.1 and MCP tool JSON Schemas. Don't edit by hand. |
| `db/migrations/` | Plain `.sql` files, applied in name order at startup. Never edit an applied file; add a new one. |
| `tests/e2e/` | Tests against a running server. They never import server code. |

**Adding a feature:** copy the structure of an existing feature in `apps/server/src/features/`, then
register it in `features/index.ts`. Put its schemas in `packages/contract/src/<name>.ts`.

## Rules

- **Git hooks** (`lefthook.yml`): pre-commit formats and lints the staged files and re-stages the fixes;
  pre-push runs `pnpm check`. Don't skip them with `--no-verify`. If a hook fails, fix the cause.
- **Feature boundaries** (enforced by Oxlint): import another feature only through its `index.ts`,
  never its internal files. `platform/` never imports a feature. Routes import features through
  `index.ts` too.
- **Portability.** The server may be rewritten in Go or Rust later. Keep these language-neutral:
  the generated contract, SQL migrations, data rules as Postgres constraints, env var names, port 8080,
  `/healthz` and `/readyz`, and the e2e tests.
- **Runtime contract.** Configuration only through env vars (`apps/server/src/platform/config.ts`). Logs are JSON
  lines on stdout.
- **TypeScript runs directly in Node** (type stripping). Only erasable syntax: no `enum`, no
  `namespace`, no parameter properties. Import local files with their `.ts` extension.
- **No Bun-only or framework magic:** no decorators, no DI containers. Use Web-standard APIs where possible.
- **Await every promise.** `no-floating-promises` is an error, because a dropped database call is a
  silent race.
- **Test against real Postgres** for anything touching claims, leases or migrations. No database mocks.

## Agent skills

### Issue tracker

GitHub Issues on forge-orbit/orrery, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default roles, each label named after its role: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
