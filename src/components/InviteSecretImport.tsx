/**
 * Respondent-side invitation-secret import.
 *
 * The contract only accepts a respondent whose secret commitment an organizer
 * registered on-chain, so this component is how an organizer-provided
 * invitation reaches the browser. It is the ONLY path by which a secret enters
 * localStorage — there is no "generate" button, because a self-minted secret
 * could never pass the Merkle-path check.
 *
 * SECRET HANDLING
 *   - The input is type="password": the secret is masked while typed.
 *   - On successful import the field is CLEARED, so the secret is not left
 *     sitting in the DOM afterwards.
 *   - The secret is never logged, never sent anywhere, and never placed in a
 *     URL. Only a boolean "has an invitation" is surfaced to the parent.
 *   - Rejected input is described by reason only ("expected 64 hex characters"),
 *     never echoed back.
 */

import { useState } from "react";
import { KeyRound, ShieldCheck, Trash2 } from "lucide-react";
import {
  importInviteSecret,
  clearStoredInviteSecret,
  hasStoredInviteSecret,
} from "../lib/inviteSecret";
import { StatusMessage } from "./StatusMessage";

interface InviteSecretImportProps {
  /**
   * Called with true/false after every successful import or clear, so the
   * parent can enable or disable submission. Receives a BOOLEAN — the secret
   * itself never leaves this component.
   */
  onChange?: (hasSecret: boolean) => void;
}

export function InviteSecretImport({ onChange }: InviteSecretImportProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState(() => hasStoredInviteSecret());

  const handleImport = () => {
    try {
      importInviteSecret(value);
      // Clear the field so the secret is not left in the DOM.
      setValue("");
      setError(null);
      setImported(true);
      onChange?.(true);
    } catch (cause) {
      // fromHex throws a descriptive, value-free message; nothing rejected is
      // stored, so a typo cannot overwrite a good secret.
      setError(cause instanceof Error ? cause.message : "That is not a valid invitation secret.");
      setImported(hasStoredInviteSecret());
    }
  };

  const handleClear = () => {
    clearStoredInviteSecret();
    setValue("");
    setError(null);
    setImported(false);
    onChange?.(false);
  };

  return (
    <div className="card invite-card">
      <h2>
        <KeyRound size={16} aria-hidden="true" /> Invitation secret
      </h2>
      {imported ? (
        <>
          <StatusMessage kind="success">
            <span className="confirmed-message">
              <ShieldCheck size={16} aria-hidden="true" /> An organizer-provided invitation secret is
              stored on this browser. You can submit feedback.
            </span>
          </StatusMessage>
          <button type="button" className="button button-secondary" onClick={handleClear}>
            <Trash2 size={14} aria-hidden="true" /> Forget this invitation
          </button>
        </>
      ) : (
        <>
          <p className="card-subtitle">
            This survey is invitation-only. Paste the invitation secret from your survey organizer
            to submit feedback. It stays on this device and is never sent to the server.
          </p>
          <label className="field">
            <span className="field-label">Invitation secret</span>
            <input
              type="password"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="64-character hex string from your organizer"
              autoComplete="off"
              spellCheck={false}
              aria-describedby="invite-secret-help"
            />
          </label>
          <p id="invite-secret-help" className="field-help">
            The secret is a 32-byte value shown as 64 hexadecimal characters. It is stored only in
            this browser.
          </p>
          {error && <StatusMessage kind="error">{error}</StatusMessage>}
          <button
            type="button"
            className="button button-primary"
            onClick={handleImport}
            disabled={value.trim().length === 0}
          >
            Save invitation secret
          </button>
        </>
      )}
    </div>
  );
}