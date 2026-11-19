// Public interface of the settings feature. Other code imports only this file.
import type { Feature } from "../../platform/feature.ts";
import type { SessionReader } from "../accounts/index.ts";
import { createSettingsRest, routes } from "./rest.ts";
import { type SettingsDeps, createSettingsService, type OutgoingMail } from "./service.ts";

export { routes as settingsRoutes };
export type { SmtpMail, SmtpSender, SettingsService } from "./service.ts";
export { SettingsError, startupWarnings } from "./service.ts";
export type { SettingsErrorKind, DeliveryErrorKind, OutgoingMail } from "./service.ts";

// What settings borrows from accounts: the session reader it authorizes with, on top
// of its own dependencies.
export type SettingsDepsWithAccounts = SettingsDeps & { sessionReader: SessionReader };

// The settings feature, plus the one mail path other features borrow: every email the
// installation sends goes through `deliver`, so the configured relay and its secrets
// stay this feature's alone.
export interface SettingsFeature extends Feature {
  deliver: (mail: OutgoingMail) => Promise<void>;
}

export function createSettingsFeature(deps: SettingsDepsWithAccounts): SettingsFeature {
  // The service falls back to the real SMTP transport when no sender is injected.
  const service = createSettingsService(deps);
  return {
    name: "settings",
    rest: createSettingsRest(service, deps.sessionReader),
    deliver: (mail) => service.deliver(mail),
  };
}
