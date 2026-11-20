// Local-only CLIENT-SIDE background heartbeat. NOT wired into Orrery or CI.
// Run this as a separate OS process alongside a CLI that is blocked on a long MCP tool call.
//
//   node scripts/harness-compat-probe/heartbeat.ts \
//     --url http://127.0.0.1:<port>/checkin/<token> --interval 10000 --duration 360000 \
//     --source codex-bg
//
// It POSTs a timestamped check-in to the local probe every interval and records the round-trip
// latency. No credentials or transcript data are read or sent.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

interface Options {
  url: string;
  intervalMs: number;
  durationMs: number;
  source: string;
  run: string;
  logPath: string;
}

function optionsFrom(argv: string[]): Options {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key?.startsWith("--") && value !== undefined) flags.set(key.slice(2), value);
  }
  const logPath = flags.get("log") ?? "/tmp/orrery-harness-probe/heartbeat.jsonl";
  return {
    url: flags.get("url") ?? "http://127.0.0.1:1/checkin/local",
    intervalMs: Number(flags.get("interval") ?? 10000),
    durationMs: Number(flags.get("duration") ?? 360000),
    source: flags.get("source") ?? "client-bg",
    run: flags.get("run") ?? "local-probe-run",
    logPath,
  };
}

const options = optionsFrom(process.argv.slice(2));
mkdirSync(dirname(options.logPath), { recursive: true });
const started = Date.now();
let count = 0;
const latencies: number[] = [];

function record(event: Record<string, unknown>): void {
  const line = JSON.stringify({ t: new Date().toISOString(), ...event });
  appendFileSync(options.logPath, `${line}\n`);
  process.stdout.write(`${line}\n`);
}

const timer = setInterval(() => {
  if (Date.now() - started >= options.durationMs) {
    clearInterval(timer);
    const total = latencies.reduce((sum, value) => sum + value, 0);
    record({
      kind: "heartbeat-summary",
      source: options.source,
      beats: count,
      avgLatencyMs: count === 0 ? null : Math.round(total / count),
      maxLatencyMs: latencies.length === 0 ? null : Math.max(...latencies),
      elapsedMs: Date.now() - started,
    });
    return;
  }
  const sentAt = Date.now();
  count += 1;
  const beat = count;
  void fetch(options.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ run: options.run, source: options.source, beat, sentAt }),
  })
    .then((response) => response.json())
    .then((body: unknown) => {
      const latencyMs = Date.now() - sentAt;
      latencies.push(latencyMs);
      record({ kind: "heartbeat", beat, source: options.source, latencyMs, accepted: body });
    })
    .catch((error: unknown) => {
      record({ kind: "heartbeat-error", beat, source: options.source, message: String(error) });
    });
}, options.intervalMs);

process.on("SIGTERM", () => {
  clearInterval(timer);
  process.exit(0);
});
