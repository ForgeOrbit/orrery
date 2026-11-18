import type { Health } from "@orrery/contract";
import { version } from "../../platform/version.ts";

export interface SystemDeps {
  // Throws if the database can't be reached.
  ping: () => Promise<void>;
}

// The service is the only file in a feature that decides anything. rest.ts and mcp.ts call it.
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
