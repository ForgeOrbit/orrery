import { z } from "zod";
import { Timestamp } from "./common.ts";
import { Actor, ProjectAccessLevel } from "./projects.ts";

// The history views (issue #32). One flat event shape carries every audit kind recorded so
// far: workspace membership and permission changes, project access grants, credential
// creation and revocation, attributed project activity, and installation access. A new
// producer adds a `kind` and its own stable `type` code here; no transport or view changes.
//
// A response never carries a credential, token hash, password, or email relay setting. The
// actors are stable identities (a human's id and email, or an agent's id and name), not
// names typed by a caller, and a deactivated author can still be shown by the same label.

export const HistoryEventKind = z
  .enum([
    "workspace_access",
    "project_access",
    "agent_key",
    "project_activity",
    "installation_access",
  ])
  .meta({ id: "HistoryEventKind" });
export type HistoryEventKind = z.infer<typeof HistoryEventKind>;

// Where the event happened. The id is stable; the name is a snapshot for readers and may
// be null for the installation, which has no display name.
export const HistoryScope = z
  .object({
    kind: z.enum(["installation", "workspace", "project"]),
    id: z.string(),
    name: z.string().nullable(),
  })
  .meta({ id: "HistoryScope" });
export type HistoryScope = z.infer<typeof HistoryScope>;

// `type` is the producing feature's stable event code. Installation codes are derived
// from the invitation lifecycle and the bootstrap record, both already persisted by
// earlier slices. `subject` is the human or agent an event concerns, when there is one.
// `level`/`previousLevel` belong to project access changes; `summary` belongs to activity.
export const HistoryEvent = z
  .object({
    id: z.string(),
    kind: HistoryEventKind,
    type: z.string(),
    scope: HistoryScope,
    createdAt: Timestamp,
    actor: Actor,
    subject: Actor.nullable(),
    summary: z.string().nullable(),
    level: ProjectAccessLevel.nullable(),
    previousLevel: ProjectAccessLevel.nullable(),
  })
  .meta({ id: "HistoryEvent" });
export type HistoryEvent = z.infer<typeof HistoryEvent>;

// Newest first. Each endpoint returns only the events the caller is allowed to see.
export const HistoryResponse = z.array(HistoryEvent).meta({ id: "HistoryResponse" });
export type HistoryResponse = z.infer<typeof HistoryResponse>;
