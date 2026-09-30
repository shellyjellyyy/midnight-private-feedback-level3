/**
 * Respondent-side invitation-secret storage.
 *
 * WHY THIS EXISTS
 *   The feedback contract requires an ORGANIZER to have registered
 *   `commitment(secret)` on-chain before the holder of `secret` can submit.
 *   The browser previously minted a fresh random secret on first use, which
 *   could never be registered — so a legitimate first-run respondent hit
 *   "invite secret is not registered" with no way to recover.
 *
 *   This module owns the respondent half of that lifecycle: an
 *   ORGANIZER-PROVIDED secret is imported and persisted, and NOTHING is ever
 *   silently generated. There is deliberately no "generate one" path, because
 *   a self-minted secret is guaranteed to fail the Merkle-path check later.
 *
 * STORAGE
 *   localStorage key `midnight-feedback-invite-secret` — the SAME key the
 *   previous implementation wrote, so a respondent who already imported a
 *   valid secret keeps working and nothing needs migrating.
 *
 * SECRET HANDLING (all deliberate)
 *   - The secret is never logged, never put in diagnostics, never placed in a
 *     URL, and never sent to any server. It is read by exactly one consumer:
 *     the `submitFeedback` witness, as a private input to the circuit.
 *   - Validation is strict: exactly 32 bytes of hex. A rejected value is never
 *     stored, so a typo cannot poison a respondent's later submissions.
 *   - Callers receive raw bytes; the hex form exists only at the storage
 *     boundary, matching the previous on-disk representation exactly.
 */

import { fromHex, toHex } from "./crypto";

/**
 * The localStorage key holding this respondent's organizer-provided invite
 * secret. Unchanged from the previous implementation — the value stored under
 * it remains lowercase hex of the raw 32 secret bytes.
 */
export const INVITE_SECRET_STORAGE_KEY = "midnight-feedback-invite-secret";

/** True when a well-formed secret is already stored for this browser. */
export function hasStoredInviteSecret(): boolean {
  return readStoredInviteSecret() !== null;
}

/**
 * Returns the stored invite secret as raw bytes, or `null` when none is stored
 * or the stored value is malformed.
 *
 * A malformed value is treated as absent (not as an error the caller must
 * handle) so a corrupted store degrades to the truthful "no secret" state and
 * the respondent can import a good one — rather than failing forever.
 */
export function readStoredInviteSecret(): Uint8Array | null {
  const raw = readRaw();
  if (raw === null) return null;
  try {
    return fromHex(raw);
  } catch {
    return null;
  }
}

/**
 * Validates and persists an organizer-provided invite secret.
 *
 * @param input The 64-character hex the organizer handed over.
 * @returns the secret as raw 32 bytes, for the caller to hand to the witness.
 * @throws when the value is not exactly 32 bytes of hex. Nothing is written on
 *   rejection, so a bad paste never replaces a good stored secret.
 */
export function importInviteSecret(input: string): Uint8Array {
  // fromHex enforces exactly 64 hex characters (32 bytes), tolerates an "0x"
  // prefix and surrounding whitespace, and throws otherwise.
  const secret = fromHex(input);
  writeRaw(toHex(secret));
  return secret;
}

/**
 * Forgets the stored secret. Used when the respondent wants to re-import a
 * different invitation (e.g. a second survey), never silently.
 */
export function clearStoredInviteSecret(): void {
  try {
    window.localStorage.removeItem(INVITE_SECRET_STORAGE_KEY);
  } catch {
    // A storage backend that refuses removal (private mode, quota) is not an
    // error the respondent can act on; the submit path will re-validate.
  }
}

/**
 * Reads the raw stored string, tolerating environments without `localStorage`
 * (SSR, tests without a DOM). Returns null when storage is unavailable so the
 * caller sees the same "no secret" state rather than a crash.
 */
function readRaw(): string | null {
  try {
    return window.localStorage.getItem(INVITE_SECRET_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeRaw(value: string): void {
  window.localStorage.setItem(INVITE_SECRET_STORAGE_KEY, value);
}