/**
 * Client-side helpers used by the frontend before a private value is ever
 * handed to the Compact circuit as a witness.
 *
 * Important: nothing in this file is the cryptography that actually secures
 * the contract. Commitment and nullifier derivation happen inside
 * `contracts/feedback.compact` itself, using Compact's `persistentHash`
 * with domain separation. That is the only hash the chain trusts.
 *
 * The helpers here exist for two narrower, off-chain jobs:
 *   1. Generating a fresh 32-byte invite secret for a new respondent.
 *   2. Compressing an arbitrary-length comment string down to a fixed
 *      32-byte digest, because the `feedbackComment` witness is typed as
 *      `Bytes<32>` and Compact circuits do not operate on variable-length
 *      strings. The contract then re-hashes that 32-byte value with its own
 *      domain tag to produce the public comment commitment.
 */

const encoder = new TextEncoder();

/** Generates a cryptographically random 32-byte invite secret. */
export function generateSecret(): Uint8Array {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** Renders bytes as a lowercase hex string, e.g. for local display/export. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Parses a hex string back into bytes. Throws on malformed input. */
export function fromHex(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase().replace(/^0x/, "");
  if (clean.length !== 64 || /[^0-9a-f]/.test(clean)) {
    throw new Error("expected a 64-character hex string (32 bytes)");
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Compresses free-text into a 32-byte SHA-256 digest so it can be passed as
 * the `feedbackComment` witness. This step never leaves the browser; only
 * the contract's own domain-separated hash of this digest is ever written
 * to the ledger.
 */
export async function digestComment(comment: string): Promise<Uint8Array> {
  const data = encoder.encode(comment.normalize("NFC"));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
}

/** True if the given string, once trimmed, is empty. Used for empty-comment handling. */
export function isBlank(value: string): boolean {
  return value.trim().length === 0;
}
