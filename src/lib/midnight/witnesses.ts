/**
 * Browser witness implementations for the feedback contract — the private
 * inputs the compiled circuits read. These run locally in this dApp; their
 * outputs are collected by midnight-js and fed into the ZK proving system.
 * No witness value is logged, rendered, or sent anywhere as plaintext.
 *
 * Witness signatures follow the generated declarations in
 * `managed/feedback/contract/index.d.ts` (`Witnesses<PS>`).
 */

import type { WitnessContext } from "@midnight-ntwrk/compact-runtime";
import type { Ledger } from "../../../managed/feedback/contract/index.js";
import type { MerklePath } from "./types.js";

/**
 * The private state threaded through every witness. It carries the invite
 * secret (commitment registered off-chain by the organizer) and the optional
 * comment digest for this submission.
 */
export type FeedbackPrivateState = {
  /** 32-byte invite secret. The source of every derived value. */
  readonly secret: Uint8Array;
  /** 32-byte SHA-256 digest of the (optional) free-text comment. */
  readonly commentDigest: Uint8Array;
  /** The rating the user picked (1–5). */
  readonly rating: bigint;
};

export const witnesses = {
  participantSecret: (
    context: WitnessContext<Ledger, FeedbackPrivateState>,
  ): [FeedbackPrivateState, Uint8Array] => [
    context.privateState,
    context.privateState.secret,
  ],

  participantMerklePath: (
    context: WitnessContext<Ledger, FeedbackPrivateState>,
    leaf: Uint8Array,
  ): [FeedbackPrivateState, MerklePath] => {
    // The commitment this secret derives is the leaf that must be proven.
    const path = context.ledger.participants.findPathForLeaf(leaf);
    if (path === undefined) {
      throw new Error(
        "This browser's invite secret is not registered for this survey. Contact the survey organizer.",
      );
    }
    return [context.privateState, path as MerklePath];
  },

  feedbackRating: (
    context: WitnessContext<Ledger, FeedbackPrivateState>,
  ): [FeedbackPrivateState, bigint] => [
    context.privateState,
    context.privateState.rating,
  ],

  feedbackComment: (
    context: WitnessContext<Ledger, FeedbackPrivateState>,
  ): [FeedbackPrivateState, Uint8Array] => [
    context.privateState,
    context.privateState.commentDigest,
  ],

  adminSecret: (
    context: WitnessContext<Ledger, FeedbackPrivateState>,
  ): [FeedbackPrivateState, Uint8Array] => {
    // Respondents never hold admin material; provide a zero preimage so the
    // circuit's admin assert fails closed if a respondent key were ever used
    // for an admin circuit.
    return [context.privateState, new Uint8Array(32)];
  },
} as const;
