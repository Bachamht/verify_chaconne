/** 结构化行日志（与 poller 同风格；按 jobId/orderId/attemptId 关联，绝不打印凭据） */
type Level = "debug" | "info" | "warn" | "error";

const REDACT_KEYS = /(key|secret|passphrase|signature|token|authorization|private)/i;

function redact(extra: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extra)) out[k] = REDACT_KEYS.test(k) ? "[redacted]" : v;
  return out;
}

function emit(level: Level, msg: string, extra?: Record<string, unknown>): void {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${msg}${
    extra && Object.keys(extra).length > 0 ? " " + JSON.stringify(redact(extra)) : ""
  }`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

export const log = {
  debug: (msg: string, extra?: Record<string, unknown>) => {
    if (process.env.LOG_DEBUG === "1") emit("debug", msg, extra);
  },
  info: (msg: string, extra?: Record<string, unknown>) => emit("info", msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => emit("warn", msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => emit("error", msg, extra),
};
