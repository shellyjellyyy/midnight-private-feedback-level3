/**
 * Redacting logger shared by the Preview-era scripts (smoke test, deploy).
 *
 * Every SDK log line passes through scrub(), which replaces any registered
 * secret (seeds, admin secret, participant secrets — raw, hex, or base64)
 * with [REDACTED] before it can reach the console. Debug/trace are dropped.
 *
 * The v9 Preprod deploy script (scripts/deploy.mjs) carries its own copy and
 * is intentionally left untouched.
 */

const SECRETS = new Set();

export const rememberSecret = (value) => {
  if (typeof value === "string" && value.length >= 32) SECRETS.add(value);
  if (value instanceof Uint8Array) {
    SECRETS.add(Buffer.from(value).toString("hex"));
    SECRETS.add(Buffer.from(value).toString("base64"));
  }
};

export const scrub = (text) => {
  let out = String(text);
  for (const s of SECRETS) {
    if (s && out.includes(s)) out = out.split(s).join("[REDACTED]");
  }
  return out;
};

export const makeRedactingLogger = () => {
  const emit = (level) => (payload, msg) => {
    const line = typeof payload === "string" ? payload : (msg ?? "");
    if (level === "debug" || level === "trace") return;
    console.log(`[${level}]`, scrub(line).slice(0, 1200));
  };
  const logger = {
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    debug: () => {},
    trace: () => {},
    fatal: emit("fatal"),
    child: () => logger,
    level: "info",
  };
  return logger;
};
