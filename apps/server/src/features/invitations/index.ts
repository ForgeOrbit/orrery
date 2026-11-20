// Public interface of the invitations feature. Other code imports only this file.
import type { Feature } from "../../platform/feature.ts";
import type { SessionReader } from "../accounts/index.ts";
import { type InvitationsServiceDeps, createInvitationsService } from "./service.ts";
import { createInvitationsRest, routes } from "./rest.ts";

export { routes as invitationsRoutes };
export type { InvitationsService } from "./service.ts";
export {
  canResendInvitation,
  effectiveInvitationState,
  invitationDeliveryMachine,
  invitationMachine,
  supersedeTargetForPending,
} from "./state-machine.ts";

// What the invitations feature is wired with: from accounts, the session reader its
// routes authorize with, the registered-email guard, the account-creation seam, and
// the verified-email mark; from settings, the one mail path.
export type InvitationsFeatureDeps = InvitationsServiceDeps & {
  sessionReader: SessionReader;
};

export function createInvitationsFeature(deps: InvitationsFeatureDeps): Feature {
  const service = createInvitationsService(deps);
  return { name: "invitations", rest: createInvitationsRest(service, deps.sessionReader) };
}
