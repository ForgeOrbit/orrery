import { describe, expect, it } from "vitest";
import {
  formatDateTime,
  formatDuration,
  formatFullDateTime,
  relativeCountdown,
  relativeTime,
} from "./time.ts";

describe("time helpers", () => {
  const base = Date.parse("2026-11-21T12:00:00.000Z");

  it("formats past relative times cleanly and guards invalid dates", () => {
    expect(relativeTime("2026-11-21T11:59:35.000Z", base)).toBe("just now");
    expect(relativeTime("2026-11-21T11:48:00.000Z", base)).toBe("12m ago");
    expect(relativeTime("2026-11-21T09:00:00.000Z", base)).toBe("3h ago");
    expect(relativeTime("2026-11-16T12:00:00.000Z", base)).toBe("5d ago");
    expect(relativeTime("not-a-date", base)).toBe("not-a-date");
  });

  it("formats future and past countdowns", () => {
    expect(relativeCountdown("2026-11-21T12:00:30.000Z", base)).toBe("in < 1m");
    expect(relativeCountdown("2026-11-21T12:25:00.000Z", base)).toBe("in 25m");
    expect(relativeCountdown("2026-11-21T15:00:00.000Z", base)).toBe("in 3h");
    expect(relativeCountdown("2026-11-24T12:00:00.000Z", base)).toBe("in 3d");
    expect(relativeCountdown("2026-11-21T11:45:00.000Z", base)).toBe("15m ago");
    expect(relativeCountdown("invalid", base)).toBe("invalid");
  });

  it("formats durations cleanly", () => {
    expect(formatDuration("2026-11-21T11:59:40.000Z", "2026-11-21T12:00:00.000Z")).toBe("< 1m");
    expect(formatDuration("2026-11-21T11:45:00.000Z", "2026-11-21T12:00:00.000Z")).toBe("15m");
    expect(formatDuration("2026-11-21T10:00:00.000Z", "2026-11-21T12:00:00.000Z")).toBe("2h");
    expect(formatDuration("2026-11-21T10:30:00.000Z", "2026-11-21T12:00:00.000Z")).toBe("1h 30m");
    expect(formatDuration("2026-11-21T11:30:00.000Z", null, base)).toBe("30m");
    expect(formatDuration("invalid", null, base)).toBe("—");
  });

  it("returns input verbatim on invalid timestamps in date formatters", () => {
    expect(formatDateTime("bad")).toBe("bad");
    expect(formatFullDateTime("bad")).toBe("bad");
  });
});
