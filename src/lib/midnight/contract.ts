/**
 * Binds the compiled Compact artifacts in `managed/feedback/` (produced by
 * `compact compile +0.34.0 contracts/feedback.compact managed/feedback`)
 * into a compact-js `CompiledContract` container — the object
 * `findDeployedContract` / `deployContract` from `@midnight-ntwrk/midnight-js-contracts`
 * accept, per the official starter pattern (`CompiledContract.make(...).pipe(...)`).
 *
 * The generated module import runs `checkRuntimeVersion('0.19.0')` at load, so
 * a runtime mismatch fails loudly here rather than mid-submission.
 *
 * This is the v9 arm of the era dispatch (see ./era.ts). The Preview/retained
 * binding lives in contract-v8.ts; exactly one arm is imported per build.
 */

import { CompiledContract } from "@midnight-ntwrk/compact-js";
import type { ProvableCircuitId } from "@midnight-ntwrk/compact-js";
import * as ManagedFeedback from "../../../managed/feedback/contract/index.js";
import type { Contract, Ledger } from "../../../managed/feedback/contract/index.js";
import { witnesses, type FeedbackPrivateState } from "./witnesses.js";

export type FeedbackContract = Contract<FeedbackPrivateState>;
/** The circuit ids the proving path can serve ZK material for. */
export type FeedbackCircuitId = ProvableCircuitId<FeedbackContract>;

export { ManagedFeedback };
export type { Ledger };

/**
 * The compiled-contract binding. `withCompiledFileAssets` points key material
 * resolution at the managed directory — in the browser this path is resolved
 * relative to the module's own URL by the SDK's asset reader.
 */
export const CompiledFeedbackContract = CompiledContract.make<FeedbackContract>(
  "Feedback",
  ManagedFeedback.Contract,
).pipe(
  CompiledContract.withWitnesses(witnesses),
  CompiledContract.withCompiledFileAssets("./managed/feedback"),
);
