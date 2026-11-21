import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tools } from "@orrery/contract";
import { z } from "zod";
import { routes } from "../src/features/index.ts";
import { openApiDocument } from "../src/platform/openapi.ts";

const out = (name: string) => fileURLToPath(new URL(`../../../contract/${name}`, import.meta.url));
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

await writeFile(out("openapi.json"), json(openApiDocument(routes)));
await writeFile(
  out("mcp-tools.json"),
  json(
    tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: z.toJSONSchema(t.input),
      outputSchema: z.toJSONSchema(t.output),
    })),
  ),
);
console.log("wrote contract/openapi.json and contract/mcp-tools.json");
