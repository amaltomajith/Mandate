/**
 * Worker logging. One line per event, with the fields that make it searchable
 * (merchant, run, duration). Readable text by default; set LOG_JSON=1 (or run
 * with NODE_ENV=production) for one JSON object per line, which log shippers
 * parse without regexes. Fields whose names look like secrets are redacted so a
 * log line can never carry a key or a password.
 */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRETISH = /(secret|password|token|authorization|api[_-]?key|\bkey\b|cookie)/i;

function clean(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = SECRETISH.test(k) ? "[redacted]" : v instanceof Error ? v.message : v;
  }
  return out;
}

export function formatLog(level: Level, msg: string, fields: Record<string, unknown> = {}, json = false): string {
  const f = clean(fields);
  if (json) return JSON.stringify({ time: new Date().toISOString(), level, msg, ...f });
  const tail = Object.entries(f)
    .map(([k, v]) => `${k}=${typeof v === "string" && /\s/.test(v) ? JSON.stringify(v) : String(v)}`)
    .join(" ");
  return `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${tail ? ` ${tail}` : ""}`;
}

const json = process.env.LOG_JSON === "1" || process.env.NODE_ENV === "production";
const min = ORDER[(process.env.LOG_LEVEL as Level) in ORDER ? (process.env.LOG_LEVEL as Level) : "info"];

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (ORDER[level] < min) return;
  const line = formatLog(level, msg, fields, json);
  (level === "error" || level === "warn" ? console.error : console.log)(line);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
