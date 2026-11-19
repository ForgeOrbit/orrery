// Public interface of the settings feature. Other code imports only this file.
import type { Feature } from "../../platform/feature.ts";
import type { SessionReader } from "../accounts/index.ts";
import { createSettingsRest, routes } from "./rest.ts";
import { type SettingsDeps, createSettingsService } from "./service.ts";

export { routes as settingsRoutes };
export type { SmtpMail, SmtpSender, SettingsService } from "./service.ts";
export { startupWarnings } from "./service.ts";

// What settings borrows from accounts: the session reader it authorizes with, on top
// of its own dependencies.
export type SettingsDepsWithAccounts = SettingsDeps & { sessionReader: SessionReader };

export function createSettingsFeature(deps: SettingsDepsWithAccounts): Feature {
  // The service falls back to the real SMTP transport when no sender is injected.
  const service = createSettingsService(deps);
  return { name: "settings", rest: createSettingsRest(service, deps.sessionReader) };
}
