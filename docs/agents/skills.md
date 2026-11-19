# Agent Skills

Project-local skills live in `.agents/skills/` and are committed to this repository. Third-party workflow packs are installed globally (`~/.agents/skills/`) rather than vendored here, keeping the repo free of upstream churn and formatter clashes.

## Project-local skills (committed)

| Skill | Purpose | When to run |
| --- | --- | --- |
| `verify-orrery` | Boots an isolated Orrery (Hono + React + Postgres + Mailpit) and proves user flows end-to-end. | Before merging user-facing API, web, MCP, or mail changes. |
| `formal-verify-orrery` | Exhaustively model-checks server concurrency, lifecycle, and access-boundary invariants (`M1`–`M9`). | Before merging changes to `apps/server/src/features/*/service.ts` or ownership migrations (`0007`–`0008`, `0012`). |

## Recommended global skill packs

Install once globally so every contributor shares the same workflow without vendoring third-party files:

```bash
npx -y skills add mattpocock/skills -g -y --skill '*'
npx -y skills add https://github.com/cursor/plugins/tree/main/pstack -g -y --skill '*'
```

## Combining the `mattpocock/skills` chain with `pstack`

Keep Matt Pocock's 6-step chain as the default backbone, and plug `pstack` in only at the gates where a ticket has tricky state, concurrency, or blast radius:

1. **`grill-with-docs` → `to-spec`**
   - *Optional `pstack` gate:* run **`statechart`** (or **`architect`**) right after `to-spec` whenever the spec introduces states, roles, retries, or locks (e.g., #27 permissions, #25 invite revoke/resend, #38 deactivation). Fix dead states before creating tickets.
2. **`to-tickets` → `implement`**
   - *Project-local + `pstack` gate:* after implementing and passing `pnpm check && pnpm test`, run **`formal-verify-orrery`** (updating it with **`maintain-formal-verification-skill`** if invariants changed) and **`verify-orrery`** to prove the real app.
3. **`code-review`**
   - *Optional `pstack` gate:* for high-risk PRs, pair `code-review` (Standards + Spec) with **`interrogate`** (adversarial, proof-backed findings) or **`blast-radius`** (checks what could break outside the diff).
4. **`retro`**
   - *Optional `pstack` gate:* whenever `retro` surfaces a repeatable agent mistake, run **`correct`** to turn it into a permanent type, lint, or test guardrail (or **`reflect`** to update a skill).
