/**
 * DEV-ONLY seam diagnostic. NOT part of the production bundle.
 *
 * WHY THIS EXISTS
 *   `midnight-js-contracts` wraps any external rejection at a provider seam in
 *   `Ledger8SeamFailedError`, which carries the provider's own failure only as a
 *   SANITIZED `cause` (class name + redacted message + cause chain). The
 *   user-facing text deliberately says nothing about the underlying reason, and
 *   that user-facing redaction is correct and is NOT weakened by this file.
 *
 *   This module exists to answer one question during local development — why did
 *   the connected wallet refuse to balance a retained ledger-v8 transaction? —
 *   by printing a WHITELISTED, SANITIZED projection of that failure to the
 *   browser console.
 *
 * WHAT IT CANNOT DO
 *   It cannot recover material the SDK already dropped. If the wallet's failure
 *   only ever existed as an enumerable own property of the rejection, it is
 *   gone before this code runs, and this module will report that absence rather
 *   than inventing a reason.
 *
 * SAFETY
 *   - Only the ten whitelisted scalar fields are read. Every other own
 *     property, and the whole object graph below them, is never touched.
 *   - Every string is passed through `redactDiagnosticText` first: hex runs,
 *     Bech32 addresses, base64 blobs and long opaque tokens are replaced with
 *     length-only markers, then the result is truncated.
 *   - The transaction itself is never passed in, logged, or referenced.
 *   - The whole body is behind `import.meta.env.DEV`, which Vite folds to the
 *     literal `false` in a production build, so the call sites become dead code
 *     and are dropped. `tests/dev-seam-diagnostic.test.ts` asserts the absence
 *     of the marker string from a real `build:preview` bundle.
 */

/** Marker used to assert this code never reaches a production bundle. */
export const DEV_DIAGNOSTIC_MARKER = "[dev-seam-diagnostic]";

/** The provider seam being called, for the log line only. */
export type SeamName = "balanceTx" | "submitTx" | "proveTx";

/** Fields read from a rejection, per level (the error itself, and its cause). */
const ALLOWED_FIELDS = ["name", "type", "code", "reason", "message"] as const;

type FailureLevel = Record<string, unknown> | null;

/**
 * Replaces anything that could carry transaction, witness, key or address
 * material with a length-only marker.
 *
 * Order matters and is deliberate. Bech32 addresses are matched first because
 * they are alphanumeric and would otherwise be swallowed by the base64 rule.
 * HEX runs are matched BEFORE base64 for the same reason: every hex character
 * is also a base64 character, so a long hex run would otherwise be reported as
 * an opaque blob. Matching hex first keeps the marker specific (a contract
 * address reports as `<hex:64>`, not `<blob:64>`) without weakening anything —
 * a value caught by either rule is redacted either way.
 */
export function redactDiagnosticText(input: unknown): string {
  if (typeof input !== "string") return "[non-string]";
  let out = input;
  // Bech32 Midnight addresses (mn_addr..., incl. the _preview suffix form).
  out = out.replace(/mn_addr[0-9a-z_]{8,}/gi, (m) => `<address:${m.length}>`);
  // Bech32m general form, defensively.
  out = out.replace(/\b[a-z]{2,6}1[02-9ac-hj-np-z]{20,}\b/gi, (m) => `<bech32:${m.length}>`);
  // Hex runs: 64+ is the contract-address / tx-hash / key width the brief calls
  // out; 32+ is already key-width. Anything hex-shaped is counted, not shown.
  out = out.replace(/[0-9a-fA-F]{32,}/g, (m) => `<hex:${m.length}>`);
  // Base64 / base64url blobs (proofs, signatures, encoded payloads).
  out = out.replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, (m) => `<blob:${m.length}>`);
  // Long numeric runs (raw DUST/DUST-cap integers).
  out = out.replace(/\b\d{15,}\b/g, (m) => `<num:${m.length}>`);
  return out.length > 400 ? `${out.slice(0, 400)}…[truncated]` : out;
}

/**
 * Projects ONE error level onto the whitelist. Returns null when the value is
 * not error-like, so a rejection that is a bare string is reported as such
 * rather than silently becoming an empty object.
 */
function projectLevel(value: unknown): FailureLevel {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") {
    // A rejection is not obliged to be an Error. Report the type only.
    return { message: redactDiagnosticText(String(value)) };
  }
  const source = value as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const field of ALLOWED_FIELDS) {
    const raw = source[field];
    if (typeof raw === "string") {
      projected[field] = redactDiagnosticText(raw);
    } else if (typeof raw === "number" || typeof raw === "boolean") {
      projected[field] = raw;
    } else if (raw !== undefined) {
      projected[field] = `[${typeof raw}]`;
    }
  }
  return projected;
}

/**
 * The sanitized projection, exported for tests. Never includes the transaction,
 * and never reads a field outside the whitelist.
 */
export function sanitizeSeamFailure(error: unknown): {
  error: FailureLevel;
  cause: FailureLevel;
} {
  const causeOwner =
    typeof error === "object" && error !== null
      ? (error as { cause?: unknown }).cause
      : undefined;
  return {
    error: projectLevel(error),
    cause: projectLevel(causeOwner),
  };
}

/**
 * Prints the sanitized projection at a seam, ONCE, and only under a dev server.
 *
 * A production build folds `import.meta.env.DEV` to `false`, so this returns
 * immediately and the guarded call sites are removed by tree-shaking. When the
 * projected levels carry no usable signal, that is reported explicitly so the
 * absence is distinguishable from a silent success.
 */
export function reportSeamFailure(seam: SeamName, error: unknown): void {
  if (!import.meta.env.DEV) return;
  const { error: level0, cause } = sanitizeSeamFailure(error);
  const signal =
    level0 === null
      ? "no error object reached this seam"
      : Object.keys(level0).length === 0
        ? "error object carried none of the whitelisted fields"
        : "see fields below";
  console.error(`${DEV_DIAGNOSTIC_MARKER} ${seam}: ${signal}`, {
    error: level0,
    cause,
  });
}
