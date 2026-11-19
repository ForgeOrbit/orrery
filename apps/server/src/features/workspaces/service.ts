import type { Workspace } from "@orrery/contract";
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { SessionAccount } from "../accounts/index.ts";
import { workspaces } from "../../db/schema.ts";

// The service is the only file in a feature that decides anything. rest.ts calls it.

export type WorkspacesErrorKind = "not_signed_in";

// Each kind is the REST error's stable code and its message the Problem's title
// (ADR-0003), so clients branch on the code and people read the title.
const messages = {
  not_signed_in: "Not signed in.",
} as const satisfies Record<WorkspacesErrorKind, string>;

export class WorkspacesError extends Error {
  readonly kind: WorkspacesErrorKind;

  constructor(kind: WorkspacesErrorKind) {
    super(messages[kind]);
    this.name = "WorkspacesError";
    this.kind = kind;
  }
}

export interface WorkspacesDeps {
  db: PostgresJsDatabase;
}

export interface WorkspacesService {
  // The workspaces the signed-in account can access.
  list(account: SessionAccount | null): Promise<Workspace[]>;
}

export function createWorkspacesService({ db }: WorkspacesDeps): WorkspacesService {
  return {
    // Access is what the caller holds, not what exists: the personal workspace owned by
    // the signed-in human (shared memberships arrive with #24). Another person's
    // personal workspace is never on this list, whoever asks, not even for a system
    // administrator.
    async list(account) {
      if (account === null) throw new WorkspacesError("not_signed_in");
      return db
        .select({ id: workspaces.id, kind: workspaces.kind, name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.personalOwnerHumanId, account.humanId))
        .orderBy(workspaces.createdAt);
    },
  };
}
