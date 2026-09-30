import { describe, expect, it } from "vitest";
import { FeedbackReferenceModel } from "../src/lib/referenceModel";

/**
 * These tests exercise `FeedbackReferenceModel`, a pure TypeScript mirror of
 * `contracts/feedback.compact`'s control flow (see referenceModel.ts for why
 * this exists and what it does not claim to test). They cover the three
 * required categories: circuit logic, state transitions, and privacy
 * behavior — plus edge cases for unauthorized and repeated actions.
 *
 * Full cryptographic verification of the real circuit — actual
 * `persistentHash` commitments, actual Merkle proofs, actual zero-knowledge
 * proving — belongs in `tests/feedback.contract.test.ts`, which runs against
 * the compiled contract once `npm run compile` has produced
 * `managed/feedback` (see that file and docs/USAGE.md).
 */

describe("circuit logic: submitFeedback", () => {
  it("accepts a valid submission from a registered respondent", () => {
    const model = new FeedbackReferenceModel();
    model.registerParticipant("secret-a");

    expect(() => model.submitFeedback("secret-a", 4, "Solid experience.")).not.toThrow();

    const snapshot = model.publicSnapshot();
    expect(snapshot.responseCount).toBe(1);
    expect(snapshot.ratingTally[4]).toBe(1);
  });

  it("rejects a rating outside the 1-5 range", () => {
    const model = new FeedbackReferenceModel();
    model.registerParticipant("secret-a");

    expect(() => model.submitFeedback("secret-a", 0, "")).toThrow(/between 1 and 5/);
    expect(() => model.submitFeedback("secret-a", 6, "")).toThrow(/between 1 and 5/);
  });

  it("rejects submissions while the survey is closed", () => {
    const model = new FeedbackReferenceModel();
    model.registerParticipant("secret-a");
    model.surveyOpen = false;

    expect(() => model.submitFeedback("secret-a", 3, "")).toThrow(/not currently accepting/);
  });

  it("rejects an unregistered respondent (unauthorized action)", () => {
    const model = new FeedbackReferenceModel();
    model.registerParticipant("secret-a");

    expect(() => model.submitFeedback("never-registered", 5, "")).toThrow(/not a registered respondent/);
  });
});

describe("state transitions", () => {
  it("increments responseCount and the matching rating bucket for each unique respondent", () => {
    const model = new FeedbackReferenceModel();
    model.registerParticipant("alice");
    model.registerParticipant("bob");
    model.registerParticipant("carol");

    model.submitFeedback("alice", 5, "Loved it.");
    model.submitFeedback("bob", 5, "Also great.");
    model.submitFeedback("carol", 2, "Could be better.");

    const snapshot = model.publicSnapshot();
    expect(snapshot.responseCount).toBe(3);
    expect(snapshot.ratingTally[5]).toBe(2);
    expect(snapshot.ratingTally[2]).toBe(1);
    expect(snapshot.ratingTally[1]).toBe(0);
    expect(snapshot.ratingTally[3]).toBe(0);
    expect(snapshot.ratingTally[4]).toBe(0);
  });

  it("keeps state consistent across a mix of valid and rejected attempts (repeated action)", () => {
    const model = new FeedbackReferenceModel();
    model.registerParticipant("alice");

    model.submitFeedback("alice", 3, "First and only valid submission.");
    expect(() => model.submitFeedback("alice", 5, "Trying to submit again.")).toThrow(
      /already submitted feedback/
    );

    const snapshot = model.publicSnapshot();
    expect(snapshot.responseCount).toBe(1);
    expect(snapshot.ratingTally[3]).toBe(1);
    expect(snapshot.ratingTally[5]).toBe(0);
  });

  it("tracks participantCount independently of responseCount", () => {
    const model = new FeedbackReferenceModel();
    model.registerParticipant("alice");
    model.registerParticipant("bob");

    const snapshot = model.publicSnapshot();
    expect(snapshot.participantCount).toBe(2);
    expect(snapshot.responseCount).toBe(0);
  });
});

describe("privacy behavior", () => {
  it("never exposes the respondent's secret anywhere in the public snapshot", () => {
    const model = new FeedbackReferenceModel();
    const secret = "super-secret-invite-value";
    model.registerParticipant(secret);
    model.submitFeedback(secret, 4, "A comment that should stay private.");

    const snapshot = model.publicSnapshot();
    const serialized = JSON.stringify({
      ...snapshot,
      usedNullifiers: Array.from(snapshot.usedNullifiers),
      commentCommitments: Array.from(snapshot.commentCommitments.entries()),
    });

    expect(serialized).not.toContain(secret);
  });

  it("never exposes the plaintext comment anywhere in the public snapshot", () => {
    const model = new FeedbackReferenceModel();
    const comment = "The plaintext of this comment must never appear on-chain.";
    model.registerParticipant("alice");
    model.submitFeedback("alice", 1, comment);

    const snapshot = model.publicSnapshot();
    const [, storedCommitment] = Array.from(snapshot.commentCommitments.entries())[0];

    expect(storedCommitment).not.toContain(comment);
    // A real one-way hash: fixed-length hex, unrelated in appearance to the input.
    expect(storedCommitment).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different nullifiers for different respondents, so responses are not linkable to each other", () => {
    const model = new FeedbackReferenceModel();
    model.registerParticipant("alice");
    model.registerParticipant("bob");

    model.submitFeedback("alice", 3, "");
    model.submitFeedback("bob", 3, "");

    const snapshot = model.publicSnapshot();
    expect(snapshot.usedNullifiers.size).toBe(2);
  });

  it("blocks a second submission from the same respondent via nullifier reuse (commitment/proof behavior)", () => {
    const model = new FeedbackReferenceModel();
    model.registerParticipant("alice");
    model.submitFeedback("alice", 2, "");

    expect(() => model.submitFeedback("alice", 5, "")).toThrow(/already submitted feedback/);
  });
});
