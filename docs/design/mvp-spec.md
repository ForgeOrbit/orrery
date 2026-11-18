# Identity, workspaces, and agent work sessions

Product decisions and testing boundaries are agreed. This is a cross-milestone spec, not a claim that the whole MVP is ready.

## Problem Statement

Teams need to coordinate human and agent work without making every action wait for a human. Current trackers do not make it clear which agent is working, which model or harness it uses, or whether another worker has already claimed the task.

The same person also needs to keep personal projects separate from team projects. Sharing must be deliberate, permissions must survive changes in membership, and removing someone must preserve the work they contributed.

Self-hosters need to bring up the installation without already having email configured. They need a way to invite people, recover access, and administer the server without automatically gaining access to everyone's projects.

## Solution

Provide one self-hosted installation containing personal and shared workspaces. Humans join by invitation, register with email and password, and can own projects personally or through a shared workspace. Shared workspace owners delegate access through a small set of workspace permissions and three project levels.

Each human can register agents. An agent uses a workspace-scoped API key to connect through MCP or REST. It can perform project work autonomously, including closing issues when authorized. Orrery tracks the agent's runs and work sessions rather than running the agents itself.

Renewable claims prevent duplicate work. Questions have a response deadline and an authorized fallback, so an absent human does not indefinitely block the system. Activity and access changes retain their attribution after people leave.

## User Stories

### Setup and accounts

1. As an installer, I want to create the first system administrator during bootstrap, so that I can start without an existing account.
2. As an installer, I want initial setup protected by a one-time secret, so that a visitor cannot claim the server before me.
3. As a system administrator, I want to configure SMTP after creating my account, so that email setup does not prevent first login.
4. As a system administrator, I want to send a test email, so that I can verify delivery before inviting people.
5. As a system administrator, I want bootstrap to remain closed after restart, so that nobody can create a second initial administrator.
6. As an invited human, I want to follow my invitation and choose a password, so that registration takes one flow.
7. As an invited human, I want that flow to verify my invited email, so that I do not repeat the same email check.
8. As an existing human, I want to accept another workspace invitation using my current account, so that I do not accumulate duplicate accounts.
9. As a human, I want email-based password recovery, so that a forgotten password does not cost me my work.
10. As a system administrator, I want a local recovery command, so that broken SMTP cannot permanently lock me out.
11. As a human, I want password reset to sign out old browser sessions, so that previous sessions no longer remain active.
12. As a human, I want API keys to remain independent of routine password reset, so that recovering my password does not break every agent.

### Workspace ownership

13. As a human, I want my own personal workspace, so that I can keep projects outside team work.
14. As a human, I want personal projects to stay private, so that joining a team does not expose them.
15. As a human, I want to create a shared workspace, so that I can collaborate with others.
16. As a workspace creator, I want to become its owner, so that I can configure the workspace immediately.
17. As a human, I want to join multiple workspaces, so that I can contribute to different teams.
18. As an owner, I want to appoint another owner, so that the workspace does not depend on one person.
19. As an owner, I want the last owner protected from accidental removal, so that the workspace stays manageable.
20. As an owner, I want authority over all workspace projects, so that I can remain accountable for its work.
21. As a member, I want project creation when it is granted to me, so that I can start work without waiting for an owner.
22. As a project creator, I want management access to the project I create, so that I can organize it.
23. As a system administrator, I want a recorded ownership recovery action, so that an abandoned workspace can be recovered.
24. As a member, I want installation administration separate from project access, so that my project is not exposed by the administrator role alone.

### Delegation and project access

25. As an owner, I want to grant project creation, invitation, removal, and permission management separately, so that delegation fits the team.
26. As a permission manager, I want to delegate access I hold, so that I can help manage the team.
27. As an owner, I want only owners to appoint permission managers, so that delegation does not spread without control.
28. As a member, I want no automatic project access from membership alone, so that project boundaries remain explicit.
29. As a reader, I want to inspect issues and knowledge, so that I can follow the work without changing it.
30. As a contributor, I want to create, update, close, and reopen issues, so that I can move work forward.
31. As a contributor, I want to comment and update knowledge, so that I can share context.
32. As a project manager, I want to manage settings and access within my authority, so that I can maintain the project.
33. As a member, I want permission checks to apply across the UI, REST, and MCP, so that changing clients cannot bypass them.

### Invitations

34. As an inviter, I want to see pending, accepted, declined, expired, and revoked invitations, so that I know who still needs access.
35. As an inviter, I want invitations to expire after seven days, so that forgotten links do not remain valid indefinitely.
36. As an inviter, I want to resend an invitation, so that a recipient can recover a missed or expired email.
37. As an inviter, I want resend to replace the old link, so that multiple valid links do not accumulate.
38. As an inviter, I want delivery failures shown separately, so that I do not mistake pending for delivered.
39. As a recipient, I want to see the workspace and permissions offered, so that I understand what I am joining.

### Agents and credentials

40. As a human, I want to register an agent under my identity, so that its actions have an accountable owner.
41. As a human, I want multiple clients to use the same agent identity, so that I can use the harness best suited to the task.
42. As a human, I want each key restricted to one workspace and selected projects, so that a credential cannot spill into unrelated work.
43. As a human, I want keys with 7, 14, 30, 60, or 90 days of validity, or Never, so that I can match their lifetime to my workflow.
44. As a human, I want 90 days selected by default, so that expiration is the normal path.
45. As a human, I want to replace a key with overlap, so that I can update clients before revoking it.
46. As an owner, I want agent permissions capped by the human's current access, so that an old key cannot retain removed authority.
47. As an agent, I want to close an issue when granted permission, so that routine completion is not held up by human approval.
48. As a member, I want to distinguish the agent from the model it uses, so that a model change does not create a different identity.
49. As a member, I want to see the reported harness, model, and run, so that I can understand how the work happened.
50. As a member, I want unavailable metadata shown as unknown, so that the interface does not invent certainty.

### Parallel work and recovery

51. As an agent, I want a parent run to coordinate several work sessions, so that I can tackle several issues in parallel.
52. As an agent, I want helpers on one issue to share its coordinated session, so that they do not compete for the same claim.
53. As a member, I want one active session per issue, so that two workers cannot unknowingly duplicate work.
54. As a member, I want claims released after five minutes without a check-in, so that a crashed worker does not reserve work forever.
55. As an agent, I want to resume the same run after interruption, so that its context and history remain connected.
56. As a resumed agent, I want to reacquire an expired claim, so that I cannot overwrite a replacement worker.
57. As a member, I want one failed subagent to affect only its session, so that its siblings can continue.

### Human input

58. As an agent, I want to ask a question through Orrery, so that the team can resolve a blocker.
59. As a contributor or manager, I want to answer those questions, so that the response does not depend on one person.
60. As an agent, I want to hold my claim while waiting and checking in, so that the issue is not started twice.
61. As a member, I want a one-hour response deadline, so that a connected but waiting worker cannot hold work indefinitely.
62. As an agent, I want to use an authorized fallback after that deadline, so that work can continue when the human is away.
63. As a manager, I want project fallback policy and issue overrides, so that autonomy is deliberate.
64. As a contributor, I want to tighten a particular issue's policy, so that a sensitive question can require an answer.
65. As a manager, I want to loosen an issue's policy when appropriate, so that routine work can proceed.
66. As an agent, I want to pause when no fallback is authorized, so that I do not guess beyond my authority.
67. As a member, I want paused issues kept in Needs input, so that another worker does not repeat the blocker.
68. As a human, I want an inbox and email notification, so that questions reach me.
69. As a human, I want a late answer treated as follow-up, so that I do not silently reverse work already performed.

### Transfers and offboarding

70. As a personal project owner, I want to transfer a project into a shared workspace, so that solo work can become team work.
71. As a workspace owner, I want to transfer a project to another shared workspace, so that ownership can follow the team.
72. As a source owner, I want to authorize that transfer, so that team work cannot be taken out by an ordinary member.
73. As a destination owner or project creator, I want to accept the transfer, so that incoming work is deliberate.
74. As a member, I want the transfer to wait for active work to finish or stop, so that it does not strand running work.
75. As a receiving member, I want history preserved but access rebuilt, so that the project arrives without inherited credentials.
76. As a departing member, I want my personal work preserved, so that leaving a team does not erase it.
77. As an owner, I want removal to revoke workspace keys and release claims, so that access stops immediately.
78. As a returning member, I want fresh grants, so that old permissions do not silently return.
79. As a system administrator, I want to deactivate accounts without deleting their contributions, so that access removal does not damage team history.
80. As a member, I want deactivated authors shown by name, so that discussions do not turn into unknown-user records.
81. As a reactivated human, I want personal work restored, so that I can return without losing it.

### History

82. As an owner or delegated manager, I want access-change history, so that I can explain why someone had access.
83. As a contributor, I want visible activity to remain tied to its actual human or agent, so that I can follow decisions.
84. As a member, I want audit visibility limited by scope, so that the log itself does not leak private work.
85. As a human, I want credential secrets excluded from history, so that auditing does not expose them.

## Implementation Decisions

### Product boundaries

- Keep the installation, workspace, project, human, agent, run, and work session distinct. Use stable identifiers independent of display names.
- One personal workspace belongs to each human. Shared workspaces have one or more owners. There is no extra workspace-administrator role in this MVP.
- Personal projects have no direct human collaborators. Authorized personal agents can access them.
- Orrery tracks agents running elsewhere. It does not launch workers or make model requests on their behalf.

### Application structure

- Extend the existing feature structure for accounts and setup, workspace access, invitations, agents and credentials, work sessions, and history. Keep policy in services and transport adapters thin.
- Keep shared request and response schemas authoritative. Generate the REST and MCP contracts from them.
- Use the existing Postgres store for durable state and database constraints for claim exclusivity and ownership invariants.
- Keep one policy path for browser and agent requests. A supplied actor name or model name is not authentication.

### Bootstrap and login

- Protect bootstrap with a deployment-supplied secret. Create the first administrator and close setup atomically. Restarting does not reset setup.
- Do not require SMTP for that first account. Record its email as unverified until the administrator completes verification.
- Create the first administrator's personal workspace in the same transaction.
- Never email a password reset to an unverified address. Until verification, the bootstrap account uses local recovery. The reset response does not reveal whether an account exists.
- The last active system administrator cannot be deactivated. A full administrator-role console is outside this spec.
- Keep deployment configuration in environment variables. Store persistent instance settings separately and expose them through authorized administration.
- Use password hashing and secure browser sessions. Do not expose passwords in responses or logs.
- Redact authorization headers, passwords, SMTP secrets, and token-bearing URLs from logs. Visiting a link (GET) changes nothing; tokens are redeemed by POST.
- Invitation registration binds the account to the invited email. A link visit alone must not complete registration or acceptance.
- An existing account can accept only when its verified email matches the invited address. Both are compared with one consistent normalization, without provider-specific rewriting. A forwarded link cannot attach the membership to another account.
- A workspace invitation to a new email creates the installation account. This is the intended invitation-only model. The inviter must be active and verified, and the offered access stays within the inviter's authority.
- Reset passwords through a short-lived, single-use recovery flow. Its exact validity period is an implementation default, not another product mode.
- Provide local administrator recovery, without a public recovery bypass or reopening setup.

### Authorization

- Workspace owners have full authority within their workspace. A member's other capabilities are explicit.
- Workspace capabilities are Create projects, Invite members, Remove members, and Manage member permissions.
- Only owners grant or remove permission management. Delegates cannot grant access they lack or turn themselves into owners.
- Revocation has the same ceiling as granting: a delegate can revoke only access they could grant. Remove members cannot remove an owner or a permission manager. Owners keep full authority.
- "Permission manager" is the workspace capability. "Project Manage" is the project level. Do not use "manager" alone for either.
- Project levels are Read, Contribute, and Manage. They are cumulative. Manage includes project configuration and access, not workspace ownership.
- The project creator receives Manage. Other members receive no project access by default.
- System administrator is installation authority. It does not imply project access.
- Ownership recovery applies only to a workspace with no active owner. It promotes an eligible member, or a reactivated former owner (this includes a workspace whose only member is that former owner), through an audited, notified action. It never promotes the acting administrator.
- For recovery and deactivation, the administrator sees a minimal installation directory: workspace identity, owners, and membership status. The directory shows no project listings and no project content.
- Human and agent project work follows the same permission boundary. Membership administration and installation settings remain human operations.

### Invitations and membership

- Track invitation lifecycle separately from email delivery and account verification.
- Pending invitations become accepted, declined, expired, or revoked. Keep the associated timestamps and inviter.
- Expiry is seven days. Resend rotates the link and starts seven days again. Retain the prior history.
- Check that the invitation is still valid and its offered access still authorized when it is accepted. This includes the check that each offered project still belongs to the workspace.
- Recipients can decline an invitation. Inviters can revoke one.
- Leaving one workspace removes only that workspace's access. Rejoining starts with fresh permissions.
- A member can leave voluntarily. The last-owner safeguard applies.

### API keys

- Keys are random credentials, shown when issued and stored as hashes. Treat them as bearer credentials, not model-provider keys.
- Each key binds an agent to one workspace and a selected set of projects. The same agent can hold several keys.
- Offer 7, 14, 30, 60, and 90 days, and Never. Default to 90 days.
- Rotation allows overlap until the old key is revoked or expires. Replacement does not change the agent.
- Effective access is limited by the key's grants and the human owner's current access. Never is not an exemption from those checks.
- Revocation, removal, and deactivation invalidate access independently of transport connection state.
- A workspace owner can revoke any key scoped to that workspace without seeing its secret. The owner cannot revoke the human's keys in other workspaces.

### Runs and work sessions

- A run corresponds to a harness conversation, including resumes. A new conversation starts a new run.
- A run can contain several work sessions. A session handles one issue; an issue has only one active session.
- Parent and child workers remain traceable. Helpers on the same issue share its coordinated session.
- Claim acquisition and renewal must be atomic. A five-minute absence releases the claim. A check-in does not mean the work is complete.
- Resume must not resurrect an old lease. Reject stale completion for an expired session and require reacquisition.
- A work session belongs to an agent, a run, a workspace, and an issue, not to one key. A replacement key can renew a session only when it has the same workspace, project, and action scope.
- Closing an issue is different from completing a session. Once work sessions exist, the following agent actions require a live session that the agent holds: session progress, edits to an issue's state or body, closure, and completion. No alternate update path may bypass this check. Reads, issue creation, ordinary comments, and knowledge edits need no claim. Permissions apply to every operation.
- Reject renewal, completion, and any action that requires a session if the session is inactive. This applies even when no other worker has claimed the issue. Evaluate in database time. Never treat an expired session as valid, and never turn a stale write into a fresh claim.
- Provide a minimal ready-work listing: open issues without an active session that are not in Needs input. A full board is not required.
- Record progress independently of the lease, so interruption does not erase it.

### Harness compatibility

- Support Claude Code CLI and Codex CLI first. Report run, parent/child identity, harness version, and model when available.
- Separate verified credential identity from reported execution metadata. Do not infer the model from an agent's display name.
- Verify real concurrent and subagent behavior before promising automatic tracking. Normal MCP access remains separate from richer reporting.
- Do not base run identity on an MCP transport session ID, in any protocol version. Measure long tool calls, heartbeats, and non-blocking wait or poll behavior before relying on them. Do not assume that hooks alone provide a continuous heartbeat.
- Preserve unknown metadata rather than synthesizing it. Record model changes over a run.

### Input and fallback

- Keep the claim while a waiting worker renews it, bounded by the response deadline.
- Default to one hour. At the deadline, use an authorized fallback or pause and release.
- A paused issue stays Needs input and is not automatically offered as ready work.
- Only humans answer questions: any human with Contribute or Manage on the project. Agents, including sibling runs, never answer. Fallback is separate from answering.
- A question resolves exactly once: open becomes answered or timed_out through one conditional update, evaluated in database time. An answer at or after the deadline is follow-up, even if no sweeper has run yet.
- A lapsed claim does not erase the question. The claim is released, the issue stays Needs input, and the worker must reacquire it before continuing.
- Fallback policy has two states: require-human and fallback-allowed. Require-human is the stricter state. The question records the concrete fallback the agent proposes. The project policy, plus any issue override, decides whether the fallback is authorized; the agent cannot authorize itself. Without an authorized fallback, the work pauses.
- Project Manage sets the project policy. Contributors can tighten an issue's policy; only project Manage can loosen it. Fallback never bypasses access checks.
- Put questions in the inbox and email the agent's owner. Do not email every progress update.
- Late answers become follow-up input. Do not automatically undo work or reopen the issue.

### Project transfer

- Allow personal-to-shared and shared-to-shared transfer within the installation.
- Require source ownership and destination Create projects authority. Different parties can perform authorization and acceptance. One party with both can finish directly.
- Require active work to finish or stop first. Show the destination and visibility change before confirmation.
- Acceptance runs as one transaction. It rechecks source authority, destination authority, that no work is active, and current project ownership. It deletes the source grants, removes the project from source keys, and invalidates or revises pending offers for the project. Moving a project back never revives old access.
- Project activity moves with the project. Source access-change events stay in the source workspace. The destination records its own receipt and grant events. The transferred project never exposes the source workspace's membership history.
- Preserve project identity and content. Rebuild grants: destination owners and receiver get Manage; previous members need new grants.
- Source keys do not follow the project. Retain historical authorship.

### Deactivation and history

- Deactivation disables login and keys without deleting authorship or content. Display a deactivated identity rather than an unknown user.
- Deactivation suspends memberships and keeps ownership history. It does not delete them.
- Reactivation restores personal work but does not restore shared grants or old keys.
- Record issue activity and sensitive access actions, including membership, permission, transfer, recovery, and credential changes. Each slice that produces an event records it from the start; the history view is not built first.
- Restrict access-change history to owners and delegated managers in scope. Ordinary activity follows project access.
- Keep secrets out of event content, notifications, and logs.

## Testing Decisions

- The primary acceptance boundary is the running installation through REST and MCP. Extend the existing black-box health and handshake tests, which already avoid importing server code.
- Test setup, identity, invitations, permissions, key lifecycle, work sessions, and history through externally visible outcomes. Assert returned access and persisted behavior, not internal call counts.
- Add focused browser checks for setup, accepting an invitation, granting access, and answering a question. API success alone does not prove those flows usable.
- Run database behavior against real Postgres, following the existing migration tests. Do not mock claims, leases, or membership changes.
- Race two claim attempts and two setup attempts. Assert exactly one winner. Race permission removal against renewal and assert access does not survive removal.
- Prove deadline boundaries in real-Postgres service tests: seven-day invitations, key expiry, five-minute claims, and one-hour questions. Place fixtures just before and just after each boundary, and run the scheduler under test control. Production uses database time. No deployed clock override exists, either as an endpoint or as configuration. Black-box e2e tests cover the flows reachable from outside. No test waits out these periods.
- Use a controlled SMTP inbox to prove invitation, reset, and input emails: a test catcher such as Mailpit, in compose and in CI. Verify resend makes the previous link unusable.
- Exercise local recovery as a command against a test installation. Verify it cannot reopen bootstrap.
- Test cross-workspace denials, including direct requests made outside the UI. Exercise the same operation through REST and MCP.
- Verify a shared key with concurrent sessions, a resumed session, and parent/child workers using the actual supported CLIs. This is the early compatibility gate. Real-CLI checks are a manual or scripted gate run with available credentials. CI uses an automated MCP protocol client.
- Each slice that produces an event proves it is persisted against real Postgres. Once the history view exists, also prove events through it, and verify that an unauthorized member cannot read them.
- Test failures as seriously as success: revoked keys, stale claims, expired links, missing model data, lost access, and late answers.

## Out of Scope

- Cross-server accounts or federation.
- OAuth human login, social login, and general third-party MCP compatibility.
- A separate workspace-admin hierarchy, custom project roles, or a full enterprise policy engine.
- Sharing personal projects directly with other humans.
- Shared-to-personal transfer, forced transfer during active work, and cross-server transfer.
- Permanent account erasure and data-retention tooling.
- Launching or hosting agents, choosing their models, or guaranteeing the truth of client-reported metadata.
- Mandatory human review for every completion.
- A complete board, rich-content renderer, or full vault editor. Only their identity and access requirements are fixed here.
- Source-code hosting, CI, repository synchronization, billing, or public workspace discovery.

## Further Notes

This work intersects the existing foundation, identity, project, agent-session, inbox, and vault milestones. Deliver it as vertical slices rather than one large implementation ticket.

Related milestones: #1 foundation, #2 identity, #3 projects, #4 agent sessions, #5 inbox, and #6 vault. Part of the overview in #8.

The current codebase is a scaffold: health endpoints, routing, MCP handshake, migrations, and build infrastructure exist. The behavior described here is not implemented yet.

The first technical risk is reliable harness attribution. Prove that early, before expanding the agents panel. A missing model field should reduce the information displayed, not make an otherwise authorized request invalid.

Use the glossary and the accepted bootstrap and workspace ADRs as the vocabulary baseline. This spec replaces the single-organization and blanket human-completion assumptions in the earlier proposal. It does not close or replace the existing milestones.
