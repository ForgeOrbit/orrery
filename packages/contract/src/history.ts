import { z } from "zod";
import { Timestamp } from "./common.ts";
import { Actor, ProjectAccessLevel } from "./projects.ts";










export const HistoryEventKind = z
  .enum([
    "workspace_access",
    "project_access",
    "agent_key",
    "project_activity",
    "installation_access",
    
    
    "account_status",
  ])
  .meta({ id: "HistoryEventKind" });
export type HistoryEventKind = z.infer<typeof HistoryEventKind>;



export const HistoryScope = z
  .object({
    kind: z.enum(["installation", "workspace", "project"]),
    id: z.string(),
    name: z.string().nullable(),
  })
  .meta({ id: "HistoryScope" });
export type HistoryScope = z.infer<typeof HistoryScope>;





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


export const HistoryResponse = z.array(HistoryEvent).meta({ id: "HistoryResponse" });
export type HistoryResponse = z.infer<typeof HistoryResponse>;
