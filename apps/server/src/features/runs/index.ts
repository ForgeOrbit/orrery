// Public interface of the runs feature. Other code imports only this file.
import type { Feature } from "../../platform/feature.ts";
import type { SessionReader } from "../accounts/index.ts";
import { createRunsMcp } from "./mcp.ts";
import { createRunsRest, routes } from "./rest.ts";
import { type RunsDeps, type RunsService, createRunsService } from "./service.ts";

export { routes as runsRoutes };
export { RunsError } from "./service.ts";
export type { RunsErrorKind, RunsService } from "./service.ts";

export type RunsFeatureDeps = RunsDeps & { sessionReader: SessionReader };

export interface RunsFeature extends Feature {
  service: RunsService;
}

export function createRunsFeature(deps: RunsFeatureDeps): RunsFeature {
  const service = createRunsService(deps);
  return {
    name: "runs",
    rest: createRunsRest(service, deps.sessionReader),
    // Run reporting borrows the agents authenticator passed to the service; the adapter
    // itself never reads or interprets a credential.
    registerTools: createRunsMcp(service),
    service,
  };
}
