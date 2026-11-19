// Public interface of the invitations feature. Other code imports only this file.
import type { Feature } from "../../platform/feature.ts";
import type { SessionReader } from "../accounts/index.ts";
import { type InvitationsServiceDeps, createInvitationsService } from "./service.ts";
import { createInvitationsRest, routes } from "./rest.ts";

export { routes as invitationsRoutes };
export type { InvitationsService } from "./service.ts";

// What invitations borrows from accounts and settings: the session reader that
// authorizes the inviter, the account-creation seam and the verified-email mark, and
// the one mail path.
export type InvitationsDepsWithAccounts = InvitationsServiceDeps & {
  sessionReader: SessionReader;
};

export function createInvitationsFeature(deps: InvitationsDepsWithAccounts): Feature {
  const service = createInvitationsService(deps);
  return { name: "invitations", rest: createInvitationsRest(service, deps.sessionReader) };
}
