/**
 * The real submission flow: attach to the deployed contract
 * (`findDeployedContract`), call `submitFeedback` through the typed
 * `callTx` interface, wait for finalization on-chain, and only then resolve.
 *
 * There is deliberately no success path that does not pass through an actual
 * network submission: every stage transition below is reached only after the
 * corresponding real operation completed without error.
 *
 * Both eras branch HERE, mirroring the official starter's session layer: the
 * v9 arm binds through the compact-js container, the Preview arm through the
 * raw retained contract instance. The two handles share the same call surface
 * (`callTx.submitFeedback`, `public.txId`, `status`), so the submission path
 * below them is era-agnostic.
 */

import {
  findDeployedContract,
  type FoundContract,
  type Ledger8,
} from "@midnight-ntwrk/midnight-js-contracts";
import { SucceedEntirely } from "@midnight-ntwrk/midnight-js-types";
import type { ContractAddress } from "@midnightntwrk/ledger-v9";
import { eraContractBinding } from "./contractDispatch.js";
import type { FeedbackContract } from "./contract.js";
import type { FeedbackContractV8 } from "./contract-v8.js";
import { FEEDBACK_PRIVATE_STATE_ID, type ProviderBundle } from "./providers.js";

/**
 * A joined contract of either era. Both twins are built from the same contract
 * source, so the union is callable directly — `handle.callTx.submitFeedback()`
 * type-checks against both arms at once, exactly as the official starter's
 * `ContractHandle` does.
 */
export type EraFoundContract =
  | FoundContract<FeedbackContract>
  | Ledger8.FoundContract<FeedbackContractV8>;

/** The address of the deployed survey contract (VITE_CONTRACT_ADDRESS). */
export function deployedContractAddress(): ContractAddress {
  const raw = import.meta.env.VITE_CONTRACT_ADDRESS?.trim();
  if (!raw) {
    throw new Error(
      "No survey contract address configured. Set VITE_CONTRACT_ADDRESS (see .env.example) and reload.",
    );
  }
  return raw as ContractAddress;
}

/** The finalized record's verdict, read back from the indexer. */
export type TxRecordStatus = {
  readonly status: string;
  readonly segmentStatusMap: Map<number, string> | undefined;
};

export type JoinedFeedback = {
  readonly handle: EraFoundContract;
  /** Reports the finalized record's transaction status after the tx is recorded. */
  readonly watchForTxData: (txId: string) => Promise<TxRecordStatus>;
  /** Releases the provider set's indexer connection. */
  readonly dispose: () => Promise<void>;
};

/**
 * Attaches to the deployed feedback contract with a full provider set.
 * `findDeployedContract` reads the chain and byte-matches the local ZK
 * artifacts against the deployed verifier keys, per era:
 *
 *   - v9: container binding, manifest-verified artifacts.
 *   - v8-preview: raw retained instance; the provider bundle was built in the
 *     same era branch (tagged `v8-preview`), so a ledger-9 provider set can
 *     never be paired with the ledger-8 contract here.
 *
 * The caller must have stored this respondent's private state under
 * {@link FEEDBACK_PRIVATE_STATE_ID} BEFORE joining: the retained-era join
 * refuses a private-state id the provider holds nothing under, rather than
 * executing against a default state.
 */
export async function joinFeedbackContract(
  bundle: ProviderBundle,
  address: ContractAddress,
): Promise<JoinedFeedback> {
  const readBack = makeStatusReader(bundle);

  try {
    if (bundle.era === "v8-preview") {
      // Preview arm — the raw retained instance from the era binding. The
      // dispatch desync branch is unreachable: the bundle and the binding are
      // derived from the same compile-time ERA constant.
      const handle = await findDeployedContract(bundle.providers, {
        compiledContract:
          eraContractBinding.era === "v8-preview"
            ? eraContractBinding.compiledContract
            : unreachableEra("v8-preview"),
        contractAddress: address,
        privateStateId: FEEDBACK_PRIVATE_STATE_ID,
      });
      return { handle, watchForTxData: readBack, dispose: bundle.dispose };
    }

    // v9 arm — the compact-js CompiledContract container.
    const handle = await findDeployedContract<FeedbackContract>(bundle.providers, {
      compiledContract:
        eraContractBinding.era === "v9"
          ? eraContractBinding.compiledContract
          : unreachableEra("v9"),
      contractAddress: address,
      privateStateId: FEEDBACK_PRIVATE_STATE_ID,
    });
    return { handle, watchForTxData: readBack, dispose: bundle.dispose };
  } catch (error) {
    await bundle.dispose().catch((disposeError: unknown) => {
      console.error("[feedback] could not release providers after a failed join", disposeError);
    });
    throw error;
  }
}

/** The two dispatch arms are built from ONE compile-time era; the other cannot appear. */
function unreachableEra(era: "v9" | "v8-preview"): never {
  throw new Error(
    `[feedback] era dispatch desync: ${era} branch reached with the other era's binding. ` +
      "This is a build-time era-switch invariant violation, not a runtime condition.",
  );
}

/** Indexer read-back, era-agnostic: both records carry status + segment map. */
function makeStatusReader(bundle: ProviderBundle) {
  return async (txId: string): Promise<TxRecordStatus> => {
    const record = await bundle.providers.publicDataProvider.watchForTxData(txId);
    // Both era arms carry the metadata this flow gates on; read the status and
    // segment map defensively across the two record shapes.
    const meta = record as {
      status?: string;
      tx?: { segmentStatusMap?: Map<number, string> };
    };
    return {
      status: meta.status ?? "unknown",
      segmentStatusMap: meta.tx?.segmentStatusMap,
    };
  };
}

/**
 * Submits one anonymous feedback response and waits for the transaction to be
 * finalized on-chain.
 *
 * Stage contract honored by the caller (useMidnight):
 *   - resolves ONLY after `watchForTxData` reports the transaction recorded;
 *   - throws before that on any failure (compose, prove, balance, submit,
 *     discarded/reverted segments).
 *
 * The submitted rating and comment digest are readable from the public
 * transaction by design; the invite secret and comment plaintext never leave
 * this function's call tree.
 */
export async function submitFeedbackTx(session: JoinedFeedback): Promise<{ txId: string }> {
  // The caller has already stored the private state under
  // FEEDBACK_PRIVATE_STATE_ID, and joinFeedbackContract carried that id, so
  // the circuit call carries no arguments and reads the stored state.
  // submitFeedback discloses the rating through the witness harness.
  const finalized = await session.handle.callTx.submitFeedback();

  const txId = finalized.public.txId;
  const { status, segmentStatusMap } = await session.watchForTxData(txId);

  // Gate on the chain's own verdict: the transaction must be recorded as
  // having succeeded entirely. FailEntirely means it was rejected outright;
  // FailFallible means it was recorded but a segment failed (e.g. the circuit
  // assert fired) — both are failures for the user, never a success.
  if (status !== SucceedEntirely) {
    throw new Error(
      `The survey contract did not accept the submission (transaction status: ${status}).`,
    );
  }
  if (segmentStatusMap !== undefined) {
    const failed = Array.from(segmentStatusMap.entries()).filter(
      ([, segmentStatus]) => segmentStatus !== "SegmentSuccess",
    );
    if (failed.length > 0) {
      throw new Error(
        `The survey contract rejected the submission (failed segments: ${failed
          .map(([id]) => id)
          .join(", ")}).`,
      );
    }
  }

  return { txId };
}
