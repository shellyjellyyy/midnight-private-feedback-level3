import { createHash } from "node:crypto";

/**
 * A pure TypeScript mirror of `contracts/feedback.compact`'s control flow
 * and state transitions.
 *
 * This is a specification double, not the contract. It exists so the
 * behavioral rules of the circuit — membership required, one nullifier per
 * secret, rating bounds, which public counters move and which never do —
 * can be exercised and tested in plain JavaScript before (or independently
 * of) running the real Compact compiler and its zero-knowledge proving
 * pipeline.
 *
 * It intentionally does NOT reimplement Compact's actual cryptography:
 * `persistentHash`, the Merkle tree, and proof generation only exist inside
 * the compiled contract and are exercised by `tests/feedback.contract.test.ts`
 * once `npm run compile` has produced `managed/feedback`. Here, "commitment"
 * and "nullifier" are computed with a plain SHA-256 (domain-tagged, same
 * idea as the contract's `persistentHash`, different primitive) rather than
 * Compact's actual hash function. That is enough to give this model a real
 * one-way, non-reversible relationship between a secret and its public
 * derivatives — which is what the privacy tests below actually check for —
 * without pretending to test Compact's own cryptography.
 */

function taggedHash(tag: string, value: string): string {
  return createHash("sha256").update(`${tag}:${value}`).digest("hex");
}

export interface PublicLedgerSnapshot {
  participantCount: number;
  responseCount: number;
  ratingTally: Record<1 | 2 | 3 | 4 | 5, number>;
  usedNullifiers: Set<string>;
  commentCommitments: Map<string, string>;
}

export class FeedbackReferenceModel {
  private registered = new Set<string>();
  private nullifiers = new Set<string>();
  private commentCommitments = new Map<string, string>();
  private tally: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  private participantCount = 0;
  private responseCount = 0;
  surveyOpen = true;

  private commitmentOf(secret: string): string {
    return taggedHash("midnight:feedback:commitment", secret);
  }

  private nullifierOf(secret: string): string {
    return taggedHash("midnight:feedback:nullifier", secret);
  }

  private commentCommitmentOf(comment: string): string {
    return taggedHash("midnight:feedback:comment", comment);
  }

  /** Mirrors registerParticipant: only a commitment is ever recorded. */
  registerParticipant(secret: string): void {
    this.registered.add(this.commitmentOf(secret));
    this.participantCount += 1;
  }

  isRegistered(secret: string): boolean {
    return this.registered.has(this.commitmentOf(secret));
  }

  /** Mirrors submitFeedback's assertions and state writes, in order. */
  submitFeedback(secret: string, rating: number, comment: string): void {
    if (!this.surveyOpen) {
      throw new Error("the survey is not currently accepting responses");
    }
    if (!this.isRegistered(secret)) {
      throw new Error("not a registered respondent for this survey");
    }

    const nullifier = this.nullifierOf(secret);
    if (this.nullifiers.has(nullifier)) {
      throw new Error("this respondent has already submitted feedback");
    }

    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new Error("rating must be between 1 and 5");
    }

    this.nullifiers.add(nullifier);
    this.responseCount += 1;
    this.tally[rating as 1 | 2 | 3 | 4 | 5] += 1;
    this.commentCommitments.set(nullifier, this.commentCommitmentOf(comment));
  }

  /** Everything an outside observer of the ledger could read. */
  publicSnapshot(): PublicLedgerSnapshot {
    return {
      participantCount: this.participantCount,
      responseCount: this.responseCount,
      ratingTally: { ...this.tally },
      usedNullifiers: new Set(this.nullifiers),
      commentCommitments: new Map(this.commentCommitments),
    };
  }
}
