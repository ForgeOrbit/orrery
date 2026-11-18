# Identity and access

This is the agreed MVP design for [M1](https://github.com/forge-orbit/orrery/issues/2), with bootstrap covered by [M0](https://github.com/forge-orbit/orrery/issues/1). It describes planned behavior, not implemented functionality. Terms are defined in [the glossary](../../GLOSSARY.md).

## Installation and accounts

One installation supports multiple personal and shared workspaces. Accounts, invitations, and API keys work within that installation. Cross-server collaboration is outside the MVP.

Human login uses email and password. Registration is invitation only. A system administrator can invite someone onto the installation. A shared workspace owner or a member with invitation permission can invite someone into that workspace.

A new recipient follows the invitation, chooses a password, and completes registration. This verifies the invited email address without a second verification email. The human receives a personal workspace and the invited membership. An existing account accepts the membership without creating another account.

Existing-account acceptance requires its verified email to match the invited address. An active, verified workspace inviter can invite a new email, creating an installation account. A forwarded link cannot grant membership to an unrelated account.

Password recovery uses email. Resetting a password signs out browser sessions but leaves API keys active. A local recovery command allows someone with server access to recover the system administrator account when email is unavailable. It does not reopen bootstrap.

Do not email resets to unverified addresses. Protect the last active system administrator from deactivation.

Account deactivation stops login and all API keys. It preserves content and historical identity. Past activity displays the person's identity as deactivated rather than replacing it with an unknown user.

Memberships are suspended rather than erased, preserving recovery history.

Reactivation restores personal work. Shared workspace access requires fresh approval, and API keys need replacement.

## Bootstrap

The installer supplies a one-time setup secret. Initial setup creates the first system administrator before SMTP is required and then closes bootstrap permanently. The administrator configures SMTP and verifies their email afterward.

Deployment essentials use environment variables. Persistent instance settings, including SMTP, are managed through the app. See [ADR-0001](../adr/0001-bootstrap-and-instance-settings.md).

## Workspaces and ownership

A personal workspace stays private to its human and their authorized agents. It has no direct collaborators. Shared workspaces contain team projects, with explicit access grants.

The shared workspace creator becomes its first owner. Multiple owners are supported, with at least one required. Owners can manage every project in their workspace.

A member can create projects when granted permission. The creator receives project management permissions. The project remains owned by the workspace.

A personal project can be explicitly transferred to a shared workspace, preserving its identity and history. The transfer preview shows the access change and the content that will move.

Transfer rebuilds access under the destination. Destination owners and the receiving member have Manage access. Previous project members need new grants. Source workspace API keys cannot access the moved project.

Shared-to-shared transfer is also supported. A source workspace owner must authorize it. A destination owner or a member with Create projects permission can receive it. If one person has authority on both sides, they can complete it in one flow. Otherwise the destination accepts the request. Shared-to-personal transfer is outside the MVP.

For the MVP, active work must finish or be stopped before transfer. Immediate transfer with claim release can be reconsidered later.

The system administrator does not automatically receive project access. They need workspace permissions for ordinary project work. Recovery is available only when no active owner remains. The administrator can appoint an eligible member or a reactivated former owner through a recorded recovery action. They cannot appoint themselves. Members are notified. This also handles a workspace whose sole member was deactivated.

For these operations the administrator sees workspace identity, owners, and membership status. They see no project listings or content.

These controls govern application access. The operator of the underlying server and database remains trusted.

## Workspace permissions

Owners have full workspace authority. Members can receive these permissions separately:

- Create projects.
- Invite members.
- Remove members.
- Manage member permissions.

Only owners can appoint or remove permission managers. Managers can delegate only permissions and project access they hold. They cannot elevate themselves, remove an owner, or transfer workspace ownership.

Revocation has the same ceiling as granting. Remove members cannot remove a permission manager. Project Manage and permission management are distinct; neither should be called just manager.

## Project levels

| Level | Allows |
| --- | --- |
| Read | View issues and project knowledge. |
| Contribute | Create and edit issues, close and reopen issues, comment, and update knowledge. |
| Manage | Contribute, plus manage project settings and access within delegation limits. |

Project levels grant no workspace-wide powers. Closing issues is permission based for humans and agents. Human review is available but is not mandatory for every completion.

## Invitations

Invitations track pending, accepted, declined, expired, and revoked states. Email verification is an account property, not an invitation state.

An invitation expires after seven days. Resending provides a fresh seven-day link and invalidates earlier links while retaining the history.

The invitation record shows the recipient, target workspace, offered permissions, inviter, expiry, and acceptance or cancellation time. Sending failures are separate from invitation status. Pending does not imply successful email delivery.

Acceptance rechecks the offered access, including whether its projects still belong to the workspace. Recipients can decline, and authorized inviters can revoke.

## Agents and API keys

Each agent belongs to a human. The human registers it and issues its API keys. Multiple clients using the same key act as the same agent, with separate runs.

Each API key is limited to one workspace and selected projects. One agent can have multiple keys. Its permissions cannot exceed its human owner's current access.

A workspace owner can revoke its keys without seeing their secrets. This gives no authority over keys in other workspaces.

Expiry choices are 7, 14, 30, 60, or 90 days, or Never. The default is 90 days. Never removes time-based expiry but does not bypass revocation or access checks.

Key replacement allows overlap. The human can create and test the replacement before revoking the old key. Both authenticate as the same agent. The old key remains subject to its original expiry and access checks.

Agents can perform project work, including closing issues when granted Contribute access. Membership administration, permission administration, and installation settings remain human operations for the MVP.

Claude Code CLI and Codex CLI are the initial supported harnesses. Their integrations report the run, harness, and available model information. Model and harness information is reported metadata, not authentication. Missing information stays unknown. A run can change models without changing the agent identity.

One parent run can coordinate multiple work sessions in parallel. Each session concerns one issue, and an issue has at most one active session. Subagents tackling different issues use separate sessions. Subagents helping with the same issue share its coordinated session. They can use the same API key without becoming separate registered agents.

A session belongs to the agent, run, workspace, and issue, not the key. A replacement key can renew only with matching project and action scope.

Resuming a harness conversation resumes the same run. A new conversation starts a new run. Resume does not restore an expired claim: the worker must reacquire it, and cannot continue if another worker now holds it.

Claims expire after five minutes without a check-in. Expiry releases the claim and marks the work session interrupted while preserving progress. A returning worker must reclaim before continuing.

Agent issue body/state edits, closure, session progress, and completion require a live session. Reject inactive sessions even if no replacement exists. Issue creation, ordinary comments, and knowledge edits remain unfenced. All operations still require project permission. A ready-work listing excludes claimed and Needs input issues.

While awaiting human input, a session keeps its claim if it continues checking in, up to a separate response deadline. At that deadline it can use an authorized fallback. Otherwise it pauses and releases its claim. The issue stays Needs input so another worker does not repeat the same blocker. A later answer makes it available to resume. The parent run can move on to other work.

The default response deadline is one hour. Any human project Contributor or Manager can answer; agents cannot. A project policy authorizes fallback behavior, with per-issue overrides. Contributors can tighten the policy, and Managers can loosen it. Fallback cannot expand the agent's permissions.

Policy has two states: require-human and fallback-allowed. Require-human is stricter. The question records its proposed fallback. Open questions become answered or timed out once, through a conditional update using database time. An answer after the deadline is follow-up even if the timeout has not been processed. Losing the claim does not erase the question.

Questions appear in an in-app inbox and generate an email notification to the agent's owner. A late answer after fallback is follow-up input rather than an automatic reversal or reopening.

This waiting policy is independent of the harness. Orrery communicates the outcome through its tools; the harness performs the continuation.

Do not infer run identity from the MCP connection. The compatibility proof must measure long tool calls, heartbeats, and nonblocking polling; hooks alone are not assumed to keep a claim alive.

## Leaving and returning

Removing someone from a workspace ends their access there and revokes its API keys. Their personal workspace and other memberships remain intact.

Affected claims are released immediately. Orrery stops accepting requests from the removed access, but does not stop the external agent process.

A returning member rejoins with fresh permissions. Old keys stay revoked. Historical contributions remain attributed to the original human or agent.

Members can also leave voluntarily, subject to the last-owner safeguard.

## Activity and access history

Record project activity and membership changes, permission changes, transfers, and key revocations. Keep attribution after deactivation.

Access-change history is restricted to owners and delegated managers within their scope. Project managers can inspect changes for their projects. Ordinary members see activity only in projects they can access. System administrators see installation events without automatic workspace visibility.

History excludes passwords, API key values, and invitation links. A key creation or revocation event identifies the credential without exposing its secret.

Project activity follows a transferred project. Source access-change history remains in the source workspace; the destination records receipt and its new grants. Recording starts with each feature, before the history view is complete.

## Verification before implementation is complete

These scenarios are acceptance conditions, not completed tests:

- Two clients sharing one key appear as separate runs of the same agent.
- Parallel subagents can claim different issues without conflicting identities.
- Two sessions cannot claim the same issue at once.
- A resumed run cannot overwrite a claim acquired by another worker.
- Removing workspace access releases its claims while preserving access elsewhere.
- Transfer blocks on active work and removes source credentials from the moved project.
- A question reaches fallback or pause even if its worker remains connected.
- A system administrator cannot inspect private project content without a grant.
- A deactivated account retains attribution, and reactivation restores no shared grants.

Implementation must prove run correlation through the real CLI integrations and revocation and claim behavior against real Postgres. These decisions do not approve the remaining MVP features for implementation.

Deadline boundaries use real-Postgres fixtures rather than production clock overrides. CI uses a protocol client; actual CLI checks run with available credentials. Test email uses a capture service.
