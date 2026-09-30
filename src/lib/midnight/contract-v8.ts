/**
 * PREVIEW-ERA (retained ledger-v8) contract binding.
 *
 * Binds the retained artifact in `managed/feedback-v8/` — compiled from the
 * SAME contracts/feedback.compact source with compactc 0.31.1 — exactly the
 * way the official `midnight-wallet-dapp` starter binds its retained artifact
 * (src/lib/types.ts): the retained (compact-runtime 0.16.0) toolchain emits a
 * raw `Contract` class with NO `CompiledContract` container, so its call sites
 * take the raw instance. `deployContract` / `findDeployedContract` accept it
 * through their `Ledger8` overloads in midnight-js-contracts 5.0.0-beta.8.
 *
 * The retained module imports @midnight-ntwrk/compact-runtime-ledger8 (runtime
 * 0.16.0) and enforces it via checkRuntimeVersion at load; the v9 artifact and
 * its runtime are untouched.
 *
 * This module is imported ONLY through the era dispatcher's dynamic import
 * (contract.ts stays the v9 arm); Vite tree-shakes the other era out of each
 * build, so the v9 bundle never ships the ledger8 runtime and the Preview
 * bundle never ships ledger-v9.
 */

import type { Ledger8 } from "@midnight-ntwrk/midnight-js-contracts";
import * as ManagedFeedbackV8 from "../../../managed/feedback-v8/contract/index.js";
import type { Ledger } from "../../../managed/feedback-v8/contract/index.js";
import { witnesses } from "./witnesses.js";
import type { FeedbackPrivateState } from "./witnesses.js";

export { ManagedFeedbackV8 };
export type { Ledger };

/**
 * The retained-era contract type for THIS dApp's private state, expressed
 * through the SDK's own Ledger8 arm (Ledger8Contract / Ledger8FoundContract /
 * Ledger8CircuitCallTxInterface all key off it).
 *
 * (`FeedbackPrivateState` is identical across eras — verified in Phase 9.)
 */
export type FeedbackContractV8 = Ledger8.Contract<FeedbackPrivateState>;

/**
 * Plain string circuit ids — unlike the current era's compact-js-branded
 * `ProvableCircuitId`s, the retained era's ids are bare literals, exactly as
 * the official starter's `RetainedCircuits` derives them.
 */
export type FeedbackCircuitIdV8 = keyof FeedbackContractV8["impureCircuits"] & string;

/**
 * The singleton instance the era dispatcher hands to deployContract /
 * findDeployedContract. Witnesses are bound at construction, exactly as the
 * generated API expects; the witness signatures are identical across eras
 * (same contract source, Phase 9), so the shared browser witnesses serve both.
 *
 * The one cast in this file is the beta.8 declaration-lag bridge, and it sits
 * HERE so nowhere else needs one: in midnight-js 5.0.0-beta.8 the SDK's
 * declared Ledger8CircuitContext carries only the three context members
 * (queryContext/privateState/zswapLocalState), while compact-runtime 0.16.0's
 * CircuitContext additionally requires `costModel` — the official starter's
 * retained typing matches only from beta.9-pre onward. At runtime the SDK's
 * retained pipeline builds the real circuit context through its own ledger8
 * engine, costModel included, so the declared 3-member type is simply behind
 * the shipped pipeline. The cast widens only that parameter position; the
 * witnesses, circuit ids, private state and callTx surface are the SDK's own
 * Ledger8 types, checked normally.
 */
export const RetainedFeedbackContractV8: FeedbackContractV8 =
  new ManagedFeedbackV8.Contract(witnesses) as unknown as FeedbackContractV8;
