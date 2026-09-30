/**
 * The participant commitment derivation — SHARED between the organizer-side
 * provisioning script and the browser, so the two can never drift apart.
 *
 * WHAT THIS IS
 *   `registerParticipant` does not take a respondent's secret. It takes the
 *   32-byte COMMITMENT of that secret, and inserts it into the public
 *   `participants` Merkle tree. At submission time `submitFeedback` re-derives
 *   the commitment from the witness secret and demands a Merkle path for that
 *   exact leaf.
 *
 *   Both sides must therefore compute the identical 32 bytes, or the
 *   respondent's submission is rejected as unregistered no matter how correct
 *   everything else is.
 *
 * THE DERIVATION (verbatim from contracts/feedback.compact)
 *   circuit taggedHash(tag, value): Bytes<32> {
 *     return persistentHash<Vector<2, Bytes<32>>>([tag, value]);
 *   }
 *   ...
 *   const commitmentTag = pad(32, "midnight:feedback:commitment");
 *   const leaf = taggedHash(commitmentTag, secret);
 *
 *   `pad(32, ...)` right-pads the ASCII tag with zeros to 32 bytes; the tag is
 *   fed as a raw `Bytes<32>` field, NOT hashed again. Reproduced below by
 *   `tagPad`.
 *
 * THIS IS NOT AN INVENTED SCHEME
 *   No new encoding, tag, or hash. This mirrors the contract exactly, and
 *   tests/participant-commitment.test.ts proves that by executing the compiled
 *   contract itself and comparing its internally derived leaf against this
 *   function's output for the same secret.
 *
 * ERA NOTE
 *   The hash lives in `@midnight-ntwrk/compact-runtime-ledger8` because the
 *   registered Preview deployment is the RETAINED ledger-v8 artifact. The
 *   live browser does not need this module at all — the contract derives the
 *   leaf internally — but the organizer script does, and it must use the SAME
 *   era's `persistentHash` that the deployed contract was compiled against.
 */

/**
 * The ledger-8 runtime, loaded through the stable (v8-era) testkit's own nested
 * copy — the same resolution `scripts/deploy-preview.mjs` performs. A bare
 * specifier here could dual-resolve to the hoisted v9 copy of
 * compact-runtime, whose `persistentHash` is a different implementation.
 *
 * Import is deferred to `loadLedger8()` so merely importing this module (as the
 * tests and any static analysis do) never drags the runtime in.
 */
export async function loadLedger8() {
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const { resolve } = await import("node:path");
  const requireFromTestkit = createRequire(
    resolve("node_modules/@midnight-ntwrk/testkit-js-stable/package.json"),
  );
  const entry = requireFromTestkit.resolve("@midnight-ntwrk/compact-runtime-ledger8");
  return import(pathToFileURL(entry).href);
}

/** The exact ASCII tag the contract pads into the commitment hash. */
export const COMMITMENT_TAG_TEXT = "midnight:feedback:commitment";

/**
 * Reproduces Compact's `pad(32, text)`: the ASCII bytes left-aligned in a
 * 32-byte field, zero-padded on the right.
 *
 * Mirrors `tagPad` in scripts/deploy-preview.mjs (which uses an equivalent
 * `subarray(0, 32)` form).
 */
export function tagPad(text) {
  const out = new Uint8Array(32);
  out.set(Buffer.from(text, "ascii").subarray(0, 32));
  return out;
}

/**
 * The participant commitment: `taggedHash(pad(32, COMMITMENT_TAG), secret)`.
 *
 * @param {Uint8Array} ledger8 the loaded ledger-8 runtime (for `persistentHash`)
 * @param {Uint8Array} secret the respondent's 32-byte invite secret, RAW — never
 *   its hex form, never anything already hashed.
 * @returns {Uint8Array} the 32-byte commitment to hand to registerParticipant
 */
export function participantCommitmentOf(ledger8, secret) {
  if (!(secret instanceof Uint8Array)) throw new TypeError("secret must be a Uint8Array");
  if (secret.length !== 32) {
    throw new Error(`invite secret must be exactly 32 bytes, got ${secret.length}`);
  }
  const bytes32 = new ledger8.CompactTypeBytes(32);
  const vector2 = new ledger8.CompactTypeVector(2, bytes32);
  return ledger8.persistentHash(vector2, [tagPad(COMMITMENT_TAG_TEXT), secret]);
}

/**
 * Parses the 64-character hex form an organizer hands a respondent into raw
 * bytes. Same rules as the browser's `fromHex`, so both ends accept exactly
 * one representation.
 *
 * Accepts an optional `0x` prefix and is case-insensitive; rejects anything
 * that is not exactly 32 bytes of hex.
 */
export function parseSecretHex(hex) {
  const clean = String(hex).trim().toLowerCase().replace(/^0x/, "");
  if (clean.length !== 64 || /[^0-9a-f]/.test(clean)) {
    throw new Error(
      "expected a 64-character hex string (32 bytes); got " +
        (clean.length === 0 ? "an empty value" : `${clean.length} character(s)`),
    );
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** Renders raw secret bytes as the lowercase hex the respondent pastes back. */
export function secretToHex(secret) {
  return Array.from(secret)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}