import type { Health } from "@orrery/contract";
import type { Sql } from "../db/client.ts";
import { version } from "../version.ts";

// The service layer holds every rule. REST and MCP are thin transports over it.
export interface SystemService {
  health(): Health;
  ready(): Promise<Health>;
}

export function createSystemService(sql: Pick<Sql, "unsafe">): SystemService {
  return {
    health: () => ({ status: "ok", version }),
    async ready() {
      try {
        await sql.unsafe("select 1");
        return { status: "ok", version };
      } catch {
        return { status: "degraded", version };
      }
    },
  };
}
