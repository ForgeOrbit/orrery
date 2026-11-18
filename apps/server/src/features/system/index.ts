// Public interface of the system feature. Other code imports only this file.
import type { Feature } from "../../platform/feature.ts";
import { createSystemRest, routes } from "./rest.ts";
import { type SystemDeps, createSystemService } from "./service.ts";

export { routes as systemRoutes };
export type { SystemService } from "./service.ts";

export function createSystemFeature(deps: SystemDeps): Feature {
  const service = createSystemService(deps);
  return { name: "system", rest: createSystemRest(service) };
}
