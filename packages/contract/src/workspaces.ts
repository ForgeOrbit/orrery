import { z } from "zod";
import { WorkspaceKind } from "./common.ts";

// One workspace the signed-in account can access (issue #23): the personal workspace
// every human owns. Shared memberships arrive with #24. The listing is scoped to the
// caller's own access: another person's personal workspace never appears in it, not
// even for a system administrator.

export const Workspace = z
  .object({
    id: z.string(),
    kind: WorkspaceKind,
    name: z.string(),
  })
  .meta({ id: "Workspace" });
export type Workspace = z.infer<typeof Workspace>;

export const WorkspacesResponse = z.array(Workspace).meta({ id: "WorkspacesResponse" });
export type WorkspacesResponse = z.infer<typeof WorkspacesResponse>;
