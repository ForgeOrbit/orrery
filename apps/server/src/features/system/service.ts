import type { Health } from "@orrery/contract";
import { version } from "../../platform/version.ts";

export interface SystemDeps {
  ping: () => Promise<void>;
}

export interface SystemService {
  health(): Health;
  ready(): Promise<Health>;
}

export function createSystemService({ ping }: SystemDeps): SystemService {
  return {
    health: () => ({ status: "ok", version }),
    async ready() {
      try {
        await ping();
        return { status: "ok", version };
      } catch {
        return { status: "degraded", version };
      }
    },
  };
}
