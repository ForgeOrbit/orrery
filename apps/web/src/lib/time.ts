const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const shortDateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
});

const compactDateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function parseDate(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  const date = parseDate(iso);
  if (date === null) return iso;
  const seconds = Math.max(0, Math.round((now - date.getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return shortDateFormatter.format(date);
}

export function relativeCountdown(iso: string, now: number = Date.now()): string {
  const date = parseDate(iso);
  if (date === null) return iso;
  const diffMs = date.getTime() - now;
  const absSeconds = Math.round(Math.abs(diffMs) / 1000);
  if (absSeconds < 60) return diffMs >= 0 ? "in < 1m" : "just now";
  const minutes = Math.floor(absSeconds / 60);
  if (minutes < 60) return diffMs >= 0 ? `in ${minutes}m` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return diffMs >= 0 ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return diffMs >= 0 ? `in ${days}d` : `${days}d ago`;
}

export function formatDateTime(iso: string): string {
  const date = parseDate(iso);
  return date === null ? iso : dateTimeFormatter.format(date);
}

export function formatCompactDateTime(iso: string): string {
  const date = parseDate(iso);
  return date === null ? iso : compactDateTimeFormatter.format(date);
}

export function formatShortDate(iso: string): string {
  const date = parseDate(iso);
  return date === null ? iso : shortDateFormatter.format(date);
}

export function formatFullDateTime(iso: string): string {
  const date = parseDate(iso);
  return date === null ? iso : date.toLocaleString();
}

export function formatDuration(
  startedAt: string,
  endedAt: string | null,
  now: number = Date.now(),
): string {
  const start = parseDate(startedAt);
  if (start === null) return "—";
  const endMs = endedAt === null ? now : (parseDate(endedAt)?.getTime() ?? Number.NaN);
  if (Number.isNaN(endMs)) return "—";
  const seconds = Math.max(0, Math.round((endMs - start.getTime()) / 1000));
  if (seconds < 60) return "< 1m";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes === 0 ? `${hours}h` : `${hours}h ${remMinutes}m`;
}
