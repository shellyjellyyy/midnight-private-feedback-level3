/**
 * A read-only panel that renders the runtime diagnostics recorded by
 * `lib/midnight/diagnostics.ts`.
 *
 * WHY THIS EXISTS
 *   The question being answered is what the BROWSER resolves its indexer
 *   configuration to at runtime, and the build under investigation is a
 *   deployed static site. Reading that off a deployed page without a DevTools
 *   console attached is unreliable, so the same objects that are logged are
 *   also rendered here.
 *
 * WHAT IT SHOWS
 *   Only the values `diagnostics.ts` records: public network endpoints, a public
 *   network id, a public contract address, era/builder labels, boolean
 *   comparisons against the known-good Node configuration, and error
 *   name/message from a failed indexer read. No wallet address, no key
 *   material, no private state and no credential is ever placed here, because
 *   none is ever recorded.
 *
 * IT CHANGES NOTHING
 *   The panel is pure output. It issues no request, alters no provider, and no
 *   control on it can change the submission flow.
 */
import { useEffect, useState } from "react";
import {
  clearDiagnosticsLog,
  diagnosticsLog,
  type DiagnosticEntry,
} from "../lib/midnight/diagnostics.js";

/** Renders one recorded entry as the compact key/value list it arrived as. */
function Entry({ entry }: { entry: DiagnosticEntry }) {
  return (
    <li>
      <div className="diagnostics-entry-head">
        <strong>{entry.label}</strong>
        <span className="diagnostics-entry-time">{entry.at}</span>
      </div>
      <pre className="diagnostics-entry-body">{JSON.stringify(entry.value, null, 2)}</pre>
    </li>
  );
}

export function DiagnosticsPanel() {
  // Re-read the module-level log on a timer so entries appended by the async
  // submission flow appear without this panel taking part in that flow.
  const [entries, setEntries] = useState<readonly DiagnosticEntry[]>(() => diagnosticsLog());

  useEffect(() => {
    const timer = window.setInterval(() => setEntries(diagnosticsLog()), 500);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <details className="diagnostics" open>
      <summary>
        Runtime diagnostics ({entries.length} {entries.length === 1 ? "entry" : "entries"})
      </summary>
      <p className="diagnostics-note">
        Public endpoints and the public contract address only. No wallet address, key or
        private state is recorded here.
      </p>
      {entries.length === 0 ? (
        <p className="diagnostics-note">Nothing recorded yet — connect the wallet and submit.</p>
      ) : (
        <ul className="diagnostics-list">
          {entries.map((entry, index) => (
            <Entry key={`${entry.at}-${index}`} entry={entry} />
          ))}
        </ul>
      )}
      <button
        type="button"
        className="diagnostics-clear"
        onClick={() => {
          clearDiagnosticsLog();
          setEntries(diagnosticsLog());
        }}
      >
        Clear
      </button>
    </details>
  );
}