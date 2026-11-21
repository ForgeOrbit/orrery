import type { Feature } from "../../platform/feature.ts";
import type { SessionReader } from "../accounts/index.ts";
import { createMyWorkRest, routes } from "./rest.ts";
import { createMyWorkService, type MyWorkDeps, type MyWorkService } from "./service.ts";

export { routes as myWorkRoutes };
export { MyWorkError } from "./service.ts";
export type { MyWorkErrorKind, MyWorkService } from "./service.ts";

export type MyWorkFeatureDeps = MyWorkDeps & { sessionReader: SessionReader };

export interface MyWorkFeature extends Feature {
  service: MyWorkService;
}

export function createMyWorkFeature(deps: MyWorkFeatureDeps): MyWorkFeature {
  const service = createMyWorkService({
    db: deps.db,
    projectAccessCeiling: deps.projectAccessCeiling,
    projectAccessAtLeast: deps.projectAccessAtLeast,
  });
  return {
    name: "my-work",
    rest: createMyWorkRest(service, deps.sessionReader),
    service,
  };
}
