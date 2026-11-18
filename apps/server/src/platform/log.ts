// Structured JSON logs on stdout, one object per line.
type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(minLevel: Level = "info"): Logger {
  const write = (level: Level) => (msg: string, fields?: Record<string, unknown>) => {
    if (order[level] < order[minLevel]) return;
    console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }));
  };
  return { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") };
}
