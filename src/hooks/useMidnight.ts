import { useCallback, useState } from "react";
import {
  connectOneAmWallet,
  type ConnectedAPI,
  type WalletConnectionState,
} from "../lib/wallet";
import { digestComment, fromHex, generateSecret, toHex } from "../lib/crypto";
import {
  buildProvidersFromConnectedAPI,
  FEEDBACK_PRIVATE_STATE_ID,
  type ProviderBundle,
} from "../lib/midnight/providers.js";
import { joinFeedbackContract, submitFeedbackTx, deployedContractAddress } from "../lib/midnight/feedback.js";
import type { FeedbackPrivateState } from "../lib/midnight/witnesses.js";

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

const SECRET_STORAGE_KEY = "midnight-feedback-invite-secret";
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

  const connect = useCallback(async () => {
    setWallet({ status: "connecting" });
    const result = await connectOneAmWallet();
    setWallet(result);
    if (result.status !== "connected") {
      setConnectedApi(null);
    }
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
   * Returns this browser's invite secret, generating and persisting a new
   * one on first use. The secret never leaves this function except to be
   * handed directly to the witness implementation — it is never logged,
   * rendered, or included in any network request as plaintext.
   */
  const getOrCreateSecret = useCallback((): Uint8Array => {
    const existing = window.localStorage.getItem(SECRET_STORAGE_KEY);
    if (existing) {
      try {
        return fromHex(existing);
      } catch {
        // fall through and mint a fresh one if storage was corrupted
      }
    }
    const fresh = generateSecret();
    window.localStorage.setItem(SECRET_STORAGE_KEY, toHex(fresh));
    return fresh;
  }, []);

  const submitFeedback = useCallback(
    async (rating: number, comment: string) => {
      if (wallet.status !== "connected" || !connectedApi) {
        setSubmission({ stage: "failed", error: "Connect 1AM Wallet before submitting." });
        return;
      }
      if (rating < 1 || rating > 5) {
        setSubmission({ stage: "failed", error: "Rating must be between 1 and 5." });
        return;
      }

      let session: Awaited<ReturnType<typeof joinFeedbackContract>> | null = null;
      try {
        setSubmission({ stage: "generating-proof" });

        const secret = getOrCreateSecret();
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
    [wallet, connectedApi, getOrCreateSecret],
  );

  return {
    wallet,
    connect,
    disconnect,
    submission,
    submitFeedback,
    connectedApi,
    setConnectedApi,
  };
}
