import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { get, type IncomingMessage } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { expect, it } from "vitest";

it("finishes an active response before exiting on SIGTERM", async () => {
  const pg = await new PostgreSqlContainer("postgres:18").start();
  const dir = await mkdtemp(join(tmpdir(), "orrery-shutdown-"));
  const listener = createServer();
  listener.listen(0);
  await once(listener, "listening");
  const address = listener.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  await new Promise<void>((resolve) => listener.close(() => resolve()));

  const size = 16 * 1024 * 1024;
  await writeFile(join(dir, "index.html"), "Orrery");
  const file = await open(join(dir, "download.bin"), "w");
  await file.truncate(size);
  await file.close();
  const child = spawn(process.execPath, [fileURLToPath(new URL("./main.ts", import.meta.url))], {
    env: {
      ...process.env,
      DATABASE_URL: pg.getConnectionUri(),
      PORT: String(address.port),
      WEB_DIST: dir,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = once(child, "exit");
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("orrery listening")) resolve();
      });
      child.once("error", reject);
      child.once("exit", () => reject(new Error(`server exited before startup: ${output}`)));
    });
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      get(`http://localhost:${address.port}/download.bin`, resolve).on("error", reject);
    });
    response.pause();
    let bytes = 0;
    const received = new Promise<number | string>((resolve) => {
      response.on("data", (chunk: Buffer) => (bytes += chunk.length));
      response.on("end", () => resolve(bytes));
      response.on("error", (error: Error) => resolve(error.message));
    });
    child.kill("SIGTERM");

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(child.exitCode).toBeNull();
    response.resume();
    expect(await received).toBe(size);
    expect(await exited).toEqual([0, null]);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    await pg.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
