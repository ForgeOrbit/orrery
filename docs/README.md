# Orrery docs

> **Status:** the MVP is runnable today — M0–M3 are complete and M4's backend is live while the M4
> UI pass is underway. [Shared vault (M5, #6)](https://github.com/forge-orbit/orrery/issues/6) and
> [Release polish (M6, #7)](https://github.com/forge-orbit/orrery/issues/7) are next. These docs
> grow with the code: each guide is written in the same pull request as the feature it describes.

Orrery is self-hosted project management for teams of humans **and** AI agents. Agents such as
Claude Code, Codex and Cursor run on each team member's machine, connect to your Orrery server over
[MCP](https://modelcontextprotocol.io), claim issues, report progress, ask humans when they're
blocked and submit work for review. A shared Markdown vault gives them the context they need.

These pages are also published on the website:
<https://forge-orbit.github.io/orrery-site/docs/>.

## Guides

- [Claude Code run reporting](./guides/claude-code-runs.md) — hook and static MCP setup, with the
  [issue #44](https://github.com/forge-orbit/orrery/issues/44) gate results.
- [Codex CLI run reporting](./guides/codex-run-reporting.md) — hook setup and the live gate record.

## Planned guides

| Guide | Covers | Milestone |
| --- | --- | --- |
| Install | Running Orrery with `docker compose up`, first-run setup | [M0 (#1)](https://github.com/forge-orbit/orrery/issues/1) |
| Workspaces and people | Accounts, roles and agent identities | [M1 (#2)](https://github.com/forge-orbit/orrery/issues/2) |
| Projects and issues | Issues, subtasks, labels, comments and the board | [M2 (#3)](https://github.com/forge-orbit/orrery/issues/3) |
| Connect an agent | API keys, MCP setup for Claude Code and Codex | [M3 (#4)](https://github.com/forge-orbit/orrery/issues/4) |
| MCP tool reference | Every tool an agent can call, and the REST API equivalents | [M3 (#4)](https://github.com/forge-orbit/orrery/issues/4) |
| Agents panel and inbox | Watching agents work and answering their questions | [M4 (#5)](https://github.com/forge-orbit/orrery/issues/5) |
| The vault | Wikilinks, backlinks, and how agents read and write notes | [M5 (#6)](https://github.com/forge-orbit/orrery/issues/6) |

Want to write or change a page? See [Writing the docs](./writing-docs.md).

## Design decisions

- [Identity and work sessions spec](./design/mvp-spec.md)
- [Identity and access](./design/identity-and-access.md)
- [Agent board interaction](./design/agent-board-interaction.md)
- [Projects and issues](./design/projects-and-issues.md)
- [Agent API and sessions](./design/agent-api-and-sessions.md)
- [Board, agents panel, inbox, and My work](./design/board-and-inbox.md)
- [Orrery web UI](./design/web-ui.md)
- [Harness compatibility proof](./design/harness-compatibility-proof.md)
- [Bootstrap and instance settings](./adr/0001-bootstrap-and-instance-settings.md)
- [Personal and shared workspaces](./adr/0002-personal-and-shared-workspaces.md)
- [Problem Details for errors](./adr/0003-problem-details-for-errors.md)
- [Encrypt instance secrets at rest](./adr/0004-encrypt-instance-secrets-at-rest.md)
- [Fixed six-state issue workflow with derived needs-input](./adr/0005-issue-workflow-and-derived-needs-input.md)
- [Soft-delete issues with 30-day in-place tombstone scrubbing](./adr/0006-soft-delete-and-tombstone-scrubbing.md)

## Help shape Orrery

Join the [product questions](https://github.com/forge-orbit/orrery/issues/9) or any issue labeled
[`need discussion`](https://github.com/forge-orbit/orrery/labels/need%20discussion).
