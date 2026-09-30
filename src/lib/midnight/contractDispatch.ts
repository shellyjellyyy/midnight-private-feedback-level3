/**
 * Era dispatch: resolves the deployed-era contract binding from the build-time
 * era switch (VITE_MIDNIGHT_ERA, see ./era.ts).
 *
 * The two eras bind DIFFERENTLY, per the official starter pattern:
 *   - v9          — a compact-js `CompiledContract` container (./contract.ts)
 *   - v8-preview  — the raw retained `Contract` instance (./contract-v8.ts)
 *
 * Exactly one era module is imported per bundle — the dynamic import arm that
 * matches the constant condition survives, the other is tree-shaken, so a v9
 * build never ships the ledger8 runtime and a Preview build never ships
 * ledger-v9. (If a bundler ever failed to eliminate the dead arm, the generated
 * modules' own checkRuntimeVersion guards would fail loudly at startup — a
 * safe, visible failure.)
 */

import { ERA } from "./era.js";
import type { FeedbackContract, FeedbackCircuitId, Ledger } from "./contract.js";
import type { FeedbackContractV8, FeedbackCircuitIdV8 } from "./contract-v8.js";

/** A contract binding of either era, tagged with which one it is. */
export type EraContractBinding =
  | {
      era: "v9";
      compiledContract: typeof import("./contract.js").CompiledFeedbackContract;
    }
  | {
      era: "v8-preview";
      compiledContract: FeedbackContractV8;
    };

export const eraContractBinding: EraContractBinding =
  ERA === "v8-preview"
    ? {
        era: "v8-preview",
        compiledContract: (await import("./contract-v8.js")).RetainedFeedbackContractV8,
      }
    : {
        era: "v9",
        compiledContract: (await import("./contract.js")).CompiledFeedbackContract,
      };

export type {
  FeedbackContract,
  FeedbackCircuitId,
  FeedbackContractV8,
  FeedbackCircuitIdV8,
  Ledger,
};
