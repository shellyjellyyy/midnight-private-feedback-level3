import { useCallback, useState } from "react";
import {
  connectWallet,
  listAvailableWallets,
  type ConnectedAPI,
  type WalletConnectionState,
  type WalletKind,
} from "../lib/wallet";
import { digestComment, toHex } from "../lib/crypto";
import {
  readStoredInviteSecret,
  hasStoredInviteSecret,
} from "../lib/inviteSecret";
import {
  buildProvidersFromConnectedAPI,
  FEEDBACK_PRIVATE_STATE_ID,
  type ProviderBundle,
} from "../lib/midnight/providers.js";
import { joinFeedbackContract, submitFeedbackTx, deployedContractAddress } from "../lib/midnight/feedback.js";
import type { FeedbackPrivateState } from "../lib/midnight/witnesses.js";

/**
 * Shown when this browser holds no organizer-provided invitation at all. This
 * is a distinct, recoverable state — the respondent can import one and retry —
 * so it is deliberately different from the "you have one but it is not
 * registered" message thrown by the `participantMerklePath` witness.
 */
export const NO_INVITE_SECRET_MESSAGE =
  "An invitation secret from the survey organizer is required.";

export type ProofStage =
  | "idle"
  | "generating-proof"
  | "submitting"
  | "confirmed"
  | "failed";

export interface SubmissionState {
  stage: ProofStage;
  error?: string;
}

/** One provider bundle per connected wallet; rebuilt on reconnect. */
let providerBundle: ProviderBundle | null = null;

/**
 * Wallet connection, local invite-secret management, and the REAL submission
 * flow for the anonymous feedback circuit.
 *
 * The flow stages map one-to-one onto what actually happens:
 *   1. `generating-proof` — providers are assembled from the connected wallet,
 *      the compiled contract in `managed/feedback` is attached to the deployed
 *      address (`findDeployedContract`), the circuit is executed locally with
 *      browser witnesses, and the transaction is proved. Any failure here is
 *      reported and the stage returns to a non-success state.
 *   2. `submitting` — the proven transaction is balanced by the wallet and
 *      submitted through `submitTransaction`.
 *   3. `confirmed` — set ONLY after the indexer reports the transaction
 *      recorded with all segments successful.
 *
 * There is no fake success path: `submitFeedback` never fabricates a result,
 * and `confirmed` is unreachable without an actual network submission.
 */
export function useMidnight() {
  const [wallet, setWallet] = useState<WalletConnectionState>({ status: "disconnected" });
  const [connectedApi, setConnectedApi] = useState<ConnectedAPI | null>(null);
  const [submission, setSubmission] = useState<SubmissionState>({ stage: "idle" });

  /**
   * Connects the wallet the user picked.
   *
   * Which wallet is connected changes nothing about eligibility or the
   * transaction flow: the same invitation secret, the same compiled contract,
   * the same provider bundle and the same submit path run either way. It
   * changes only WHO pays the fee — the connected wallet balances and submits
   * with its own DUST.
   */
  const connect = useCallback(async (kind: WalletKind) => {
    setWallet({ status: "connecting" });
    const result = await connectWallet(kind);
    setWallet(result);
    // Retain the live ConnectedAPI on success and clear it on every other
    // outcome. The submission flow needs this handle: `wallet` alone carries
    // only the address and network, and the connector cannot hand the API back
    // after connect() has resolved. Without this the form's submit guard sees a
    // null `connectedApi` and refuses with "Connect a wallet before
    // submitting." even though the wallet card shows a live connection.
    setConnectedApi(result.status === "connected" ? result.api : null);
  }, []);

  const disconnect = useCallback(() => {
    // Release the indexer connection owned by the last provider bundle.
    void providerBundle?.dispose().catch((error: unknown) => {
      console.error("[useMidnight] provider disposal failed", error);
    });
    providerBundle = null;
    setWallet({ status: "disconnected" });
    setConnectedApi(null);
    setSubmission({ stage: "idle" });
  }, []);

  /**
   * Returns this browser's organizer-provided invite secret, or null when none
   * is stored.
   *
   * There is deliberately NO generation path here. The contract only accepts a
   * secret whose commitment an organizer registered on-chain, so a secret
   * minted in the browser is guaranteed to fail the Merkle-path check. The
   * previous implementation generated one on first use, which made a
   * legitimate first-run respondent fail with an error they could not act on.
   */
  const getProvisionedSecret = useCallback((): Uint8Array | null => {
    return readStoredInviteSecret();
  }, []);

  const submitFeedback = useCallback(
    async (rating: number, comment: string) => {
      if (wallet.status !== "connected" || !connectedApi) {
        setSubmission({ stage: "failed", error: "Connect a wallet before submitting." });
        return;
      }
      if (rating < 1 || rating > 5) {
        setSubmission({ stage: "failed", error: "Rating must be between 1 and 5." });
        return;
      }

      // An organizer-provided invitation is a PRE-CONDITION, checked before any
      // provider is built or any proof is attempted. Failing here yields the
      // truthful "you have no invitation" message and costs the respondent
      // nothing; reaching the witness with no secret would instead fail deep in
      // proving with a much less actionable error.
      if (!hasStoredInviteSecret()) {
        setSubmission({ stage: "failed", error: NO_INVITE_SECRET_MESSAGE });
        return;
      }

      let session: Awaited<ReturnType<typeof joinFeedbackContract>> | null = null;
      try {
        setSubmission({ stage: "generating-proof" });

        const secret = getProvisionedSecret();
        if (secret === null) {
          // Unreachable given the guard above (storage could only change between
          // the two synchronous calls, or be unreadable); handled rather than
          // assumed so the witness never receives an undefined secret.
          setSubmission({ stage: "failed", error: NO_INVITE_SECRET_MESSAGE });
          return;
        }
        const commentDigest = await digestComment(comment);

        const privateState: FeedbackPrivateState = {
          secret,
          commentDigest,
          rating: BigInt(rating),
        };

        // One provider set per connection; rebuilt only if absent.
        if (providerBundle === null) {
          providerBundle = await buildProvidersFromConnectedAPI(connectedApi, {
            networkId: wallet.networkId,
          });
        }

        const address = deployedContractAddress();

        // Scope the private-state provider to the deployed contract BEFORE any
        // get/set/remove. `PrivateStateProvider.setContractAddress` is
        // documented as mandatory before those operations, and the provider
        // throws "Contract address not set. Call setContractAddress() before
        // accessing private state." without it.
        //
        // `findDeployedContract` scopes the provider itself, but only DURING the
        // join — and this pre-join `set()` happens before that, which is why it
        // must be scoped here. This mirrors the working Node flow in
        // scripts/diag-submitfeedback.mjs, which calls setContractAddress
        // immediately after constructing the provider.
        //
        // The provider bundle is cached across submits, so this is safe to
        // re-apply: it is the same address, and scoping is idempotent.
        providerBundle.providers.privateStateProvider.setContractAddress(address);

        // Store the private state BEFORE joining: the join reads and re-stores
        // the state under the well-known id, and the retained-era join refuses
        // an id the provider holds nothing under.
        await providerBundle.providers.privateStateProvider.set(
          FEEDBACK_PRIVATE_STATE_ID,
          privateState,
        );

        session = await joinFeedbackContract(providerBundle, address);

        setSubmission({ stage: "submitting" });
        const { txId } = await submitFeedbackTx(session);

        // `submitFeedbackTx` resolved only after the indexer recorded the
        // transaction with all segments successful.
        setSubmission({ stage: "confirmed" });
        void txId;
      } catch (error) {
        // A failed join leaves the bundle unusable for a clean retry — drop
        // it so the next attempt rebuilds from scratch.
        providerBundle = null;
        setSubmission({
          stage: "failed",
          error: error instanceof Error ? error.message : "The submission failed. Please try again.",
        });
      } finally {
        if (session) {
          await session.dispose().catch((disposeError: unknown) => {
            console.error("[useMidnight] session disposal failed", disposeError);
          });
        }
      }
    },
    [wallet, connectedApi, getProvisionedSecret],
  );

  return {
    wallet,
    connect,
    disconnect,
    submission,
    submitFeedback,
    connectedApi,
    setConnectedApi,
    hasInviteSecret: hasStoredInviteSecret,
    availableWallets: listAvailableWallets(),
  };
}
