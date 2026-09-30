/**
 * Contract tests — these execute the GENERATED Compact contract in
 * `managed/feedback/` (produced by `compact compile +0.34.0 --skip-zk
 * contracts/feedback.compact managed/feedback`) through the real Midnight
 * runtime `@midnight-ntwrk/compact-runtime@0.19.0` — the exact runtime
 * version the generated module asserts at import time
 * (`__compactRuntime.checkRuntimeVersion('0.19.0')`).
 *
 * How the offline harness works (verified against the installed package's
 * typings/source — no network, no node provider, no fabricated runner):
 *   - `new Contract(witnesses)` is the generated factory. The witnesses are
 *     the five private inputs the compiled circuits read: `participantSecret`,
 *     `participantMerklePath`, `feedbackRating`, `feedbackComment`,
 *     `adminSecret`.
 *   - `contract.initialState(createConstructorContext(...), admin)` runs the
 *     compiled constructor and returns the initial public `ContractState`.
 *   - `createCircuitContext(circuitId, address, zswapState, state, private)`
 *     builds the `CircuitContext` each circuit call consumes; the updated
 *     public state returns on
 *     `results.context.callContext.currentQueryContext.state` and feeds the
 *     next call — the threading the runtime itself documents.
 *   - `ledger(state)` reads the projected public ledger (`Ledger` as declared
 *     in `managed/feedback/contract/index.d.ts`).
 *   - Successful calls also produce `context.callProofDataTrace` — the
 *     proof-data transcript (circuit id, public transcript, private witness
 *     outputs) that ZK proving would consume; asserted below.
 *
 * What remains impossible offline: generating/verifying the actual ZK proof
 * and submitting transactions to a node. That step needs the prover + a live
 * Midnight node (neither is an npm dependency of this repo); the compile used
 * `--skip-zk`. Everything the circuits *assert* and every ledger mutation they
 * perform IS executed here by the compiled contract code itself.
 *
 * NOTE: none of these tests touch `src/lib/referenceModel.ts`. The reference
 * model has its own separate suite in `feedback-reference-model.test.ts`.
 */

import { readFileSync } from "node:fs";
import { TextEncoder } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CompactTypeBytes,
  CompactTypeVector,
  ContractState,
  createCircuitContext,
  createConstructorContext,
  dummyContractAddress,
  encodeContractAddress,
  persistentHash,
} from "@midnight-ntwrk/compact-runtime";
import type {
  ChargedState,
  EncodedZswapLocalState,
} from "@midnight-ntwrk/compact-runtime";
import { Contract, ledger } from "../managed/feedback/contract/index.js";
import type { Ledger, Witnesses } from "../managed/feedback/contract/index.js";

// ---------------------------------------------------------------------------
// Artifact-level facts (read from the generated managed/feedback directory)
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const managedDir = resolve(__dirname, "../managed/feedback");
const contractInfo = JSON.parse(
  readFileSync(resolve(managedDir, "compiler/contract-info.json"), "utf8"),
);
const contractManifest = JSON.parse(
  readFileSync(resolve(managedDir, "compiler/contract-manifest.json"), "utf8"),
);

// ---------------------------------------------------------------------------
// Cryptographic derivations — done with the runtime's own persistentHash,
// using the domain-separation tags baked into the generated contract module.
// ---------------------------------------------------------------------------

const bytes32 = new CompactTypeBytes(32);
const vector2 = new CompactTypeVector(2, bytes32);
const vector3 = new CompactTypeVector(3, bytes32);

function tag(text: string): Uint8Array {
  const out = new Uint8Array(32);
  out.set(new TextEncoder().encode(text)); // right-padded with zeros, like pad(32, ...)
  return out;
}
const taggedHash = (t: Uint8Array, value: Uint8Array): Uint8Array =>
  persistentHash(vector2, [t, value]);

const ADDRESS = dummyContractAddress();
const COIN_PUBLIC_KEY = { bytes: new Uint8Array(32) };

const TAG_COMMITMENT = tag("midnight:feedback:commitment");
const TAG_NULLIFIER = tag("midnight:feedback:nullifier");
const TAG_COMMENT = tag("midnight:feedback:comment");
const TAG_ADMIN_IDENTITY = tag("midnight:feedback:admin:identity");

const commitmentOf = (secret: Uint8Array): Uint8Array =>
  taggedHash(TAG_COMMITMENT, secret);
const adminIdentityOf = (secret: Uint8Array): Uint8Array =>
  taggedHash(TAG_ADMIN_IDENTITY, secret);
const commentCommitmentOf = (comment: Uint8Array): Uint8Array =>
  taggedHash(TAG_COMMENT, comment);
/** Nullifier = tagged hash scoped by THIS contract instance's address. */
const nullifierOf = (secret: Uint8Array, addressBytes?: Uint8Array): Uint8Array =>
  persistentHash(vector3, [
    TAG_NULLIFIER,
    addressBytes ?? encodeContractAddress(ADDRESS),
    secret,
  ]);

function secretByte(fill: number): Uint8Array {
  const out = new Uint8Array(32);
  out.fill(fill);
  return out;
}

const ADMIN_SECRET = secretByte(0xaa);
const WRONG_ADMIN_SECRET = secretByte(0xbb);
const ALICE = secretByte(0x01);
const BOB = secretByte(0x02);
const MALLORY = secretByte(0x03); // never registered

// ---------------------------------------------------------------------------
// Witness harness: the five generated witnesses read from this mutable bag,
// so each test steers the *private* inputs while the compiled circuits stay
// untouched. The bag itself is the contract's private state (PS).
// ---------------------------------------------------------------------------

type PathEntry = { sibling: { field: bigint }; goes_left: boolean };
type MerklePath = { leaf: Uint8Array; path: PathEntry[] };

type Harness = {
  secret: Uint8Array;
  adminSecret: Uint8Array;
  rating: bigint;
  comment: Uint8Array;
  /** "honest": look the path up in the real ledger tree.
   *  "fabricated": hand the circuit a self-consistent but bogus path.
   *  "tampered": honest path whose leaf byte is flipped.
   *  "victim": another participant's genuine path (leaf = victimLeaf). */
  pathMode: "honest" | "fabricated" | "tampered" | "victim";
  victimLeaf?: Uint8Array;
};

const harness: Harness = {
  secret: ALICE,
  adminSecret: ADMIN_SECRET,
  rating: 4n,
  comment: new Uint8Array(32).fill(7),
  pathMode: "honest",
};

function fabricatedPath(leaf: Uint8Array): MerklePath {
  return {
    leaf,
    path: Array.from({ length: 10 }, () => ({
      sibling: { field: 0n },
      goes_left: false,
    })),
  };
}

const witnesses: Witnesses<Harness> = {
  participantSecret: (ctx) => [ctx.privateState, ctx.privateState.secret],
  participantMerklePath: (ctx, leaf) => {
    const h = ctx.privateState;
    if (h.pathMode === "fabricated") return [h, fabricatedPath(leaf)];
    if (h.pathMode === "victim") {
      if (!h.victimLeaf) throw new Error("victimLeaf not set by test");
      const path = ctx.ledger.participants.findPathForLeaf(h.victimLeaf);
      if (!path) throw new Error("victim has no Merkle path in the ledger tree");
      return [h, path];
    }
    const path = ctx.ledger.participants.findPathForLeaf(leaf);
    if (!path) throw new Error("no Merkle path for leaf: secret is not a registered respondent");
    if (h.pathMode === "tampered") {
      const tamperedLeaf = Uint8Array.from(path.leaf);
      tamperedLeaf[0] ^= 0xff;
      return [h, { leaf: tamperedLeaf, path: path.path }];
    }
    return [h, path];
  },
  feedbackRating: (ctx) => [ctx.privateState, ctx.privateState.rating],
  feedbackComment: (ctx) => [ctx.privateState, ctx.privateState.comment],
  adminSecret: (ctx) => [ctx.privateState, ctx.privateState.adminSecret],
};

// ---------------------------------------------------------------------------
// Execution harness: deploy, then thread state through circuit calls.
// ---------------------------------------------------------------------------

let contract: Contract<Harness>;
let state: ContractState | ChargedState;
let zswap: EncodedZswapLocalState;

async function deploy(): Promise<void> {
  contract = new Contract(witnesses);
  const init = await contract.initialState(
    createConstructorContext(harness, COIN_PUBLIC_KEY),
    adminIdentityOf(ADMIN_SECRET),
  );
  state = init.currentContractState;
  zswap = init.currentZswapLocalState;
}

function currentLedger(): Ledger {
  return ledger(state instanceof ContractState ? state.data : state);
}

function nextContext(circuitId: string) {
  return createCircuitContext(circuitId, ADDRESS, zswap, state, harness);
}

async function registerAsAdmin(leaf: Uint8Array) {
  const results = await contract.circuits.registerParticipant(
    nextContext("registerParticipant"),
    leaf,
  );
  state = results.context.callContext.currentQueryContext.state;
  return results;
}

async function setSurveyOpen(isOpen: boolean) {
  const results = await contract.circuits.setSurveyOpen(
    nextContext("setSurveyOpen"),
    isOpen,
  );
  state = results.context.callContext.currentQueryContext.state;
  return results;
}

async function submitFeedback() {
  const results = await contract.circuits.submitFeedback(nextContext("submitFeedback"));
  state = results.context.callContext.currentQueryContext.state;
  return results;
}

beforeEach(async () => {
  harness.secret = ALICE;
  harness.adminSecret = ADMIN_SECRET;
  harness.rating = 4n;
  harness.comment = new Uint8Array(32).fill(7);
  harness.pathMode = "honest";
  harness.victimLeaf = undefined;
  await deploy();
});

// ---------------------------------------------------------------------------
// 1. Generated artifacts
// ---------------------------------------------------------------------------

describe("generated artifacts (managed/feedback)", () => {
  it("report compiler 0.34.0, language 0.26.0, runtime 0.19.0, three circuits and five witnesses", () => {
    expect(contractInfo["compiler-version"]).toBe("0.34.0");
    expect(contractInfo["language-version"]).toBe("0.26.0");
    expect(contractInfo["runtime-version"]).toBe("0.19.0");
    expect(contractInfo.circuits.map((c: { name: string }) => c.name)).toEqual([
      "registerParticipant",
      "setSurveyOpen",
      "submitFeedback",
    ]);
    expect(contractInfo.circuits.every((c: { proof: boolean }) => c.proof)).toBe(true);
    expect(contractInfo.witnesses.map((w: { name: string }) => w.name)).toEqual([
      "participantSecret",
      "participantMerklePath",
      "feedbackRating",
      "feedbackComment",
      "adminSecret",
    ]);
  });

  it("carry proving metadata (.zkir) for every circuit in the manifest", () => {
    expect(contractManifest["runtime-version"]).toBe("0.19.0");
    expect(contractManifest.zkir.type).toBe("directory");
    expect(
      Object.keys(contractManifest.zkir).filter((k) => k.endsWith(".zkir")),
    ).toEqual([
      "registerParticipant.zkir",
      "setSurveyOpen.zkir",
      "submitFeedback.zkir",
    ]);
    expect(contractManifest.contract["index.js"].size).toBeGreaterThan(0);
    expect(contractManifest.contract["index.js"].hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("export the Contract factory, ledger projector and three impure circuits (import also proves runtime version matches)", () => {
    // Importing the module already ran checkRuntimeVersion('0.19.0') against
    // the installed runtime — a mismatch would have thrown at module load.
    expect(typeof Contract).toBe("function");
    expect(typeof ledger).toBe("function");
    expect(Object.keys(contract.circuits).sort()).toEqual([
      "registerParticipant",
      "setSurveyOpen",
      "submitFeedback",
    ]);
    expect(contract.impureCircuits.registerParticipant).toBeTypeOf("function");
    expect(contract.provableCircuits.submitFeedback).toBeTypeOf("function");
  });
});

// ---------------------------------------------------------------------------
// 2. Constructor / initial state
// ---------------------------------------------------------------------------

describe("contract construction and initial state", () => {
  it("initializes an open survey with the pinned admin identity and an empty public ledger", () => {
    const l = currentLedger();
    expect(l.surveyOpen).toBe(true);
    expect(Array.from(l.adminAddress)).toEqual(
      Array.from(adminIdentityOf(ADMIN_SECRET)),
    );
    expect(l.participantCount).toBe(0n);
    expect(l.responseCount).toBe(0n);
    expect(l.rating1 + l.rating2 + l.rating3 + l.rating4 + l.rating5).toBe(0n);
    expect(l.usedNullifiers.isEmpty()).toBe(true);
    expect(l.usedNullifiers.size()).toBe(0n);
    expect(l.commentCommitments.isEmpty()).toBe(true);
    expect(l.participants.firstFree()).toBe(0n);
    expect(l.participants.findPathForLeaf(commitmentOf(ALICE))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. registerParticipant — admin authorization
// ---------------------------------------------------------------------------

describe("registerParticipant circuit", () => {
  it("accepts the correct admin secret and inserts the commitment into the Merkle tree", async () => {
    const leaf = commitmentOf(ALICE);
    const results = await registerAsAdmin(leaf);

    const l = currentLedger();
    expect(l.participantCount).toBe(1n);
    const path = l.participants.findPathForLeaf(leaf);
    expect(path).toBeDefined();
    expect(path!.leaf).toEqual(leaf);
    expect(path!.path).toHaveLength(10);

    // The successful call produced proof data for the register circuit.
    const trace = results.context.callProofDataTrace;
    expect(trace).toHaveLength(1);
    expect(trace[0].circuitId).toBe("registerParticipant");
    expect(trace[0].privateTranscriptOutputs).toHaveLength(1); // adminSecret witness
  });

  it("rejects an incorrect admin secret and leaves the ledger untouched", async () => {
    harness.adminSecret = WRONG_ADMIN_SECRET;
    await expect(registerAsAdmin(commitmentOf(ALICE))).rejects.toThrow(
      "only the admin can register participants",
    );
    expect(currentLedger().participantCount).toBe(0n);
    expect(
      currentLedger().participants.findPathForLeaf(commitmentOf(ALICE)),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. setSurveyOpen — admin authorization + state transition
// ---------------------------------------------------------------------------

describe("setSurveyOpen circuit", () => {
  it("closes and reopens the survey with the correct admin secret", async () => {
    await setSurveyOpen(false);
    expect(currentLedger().surveyOpen).toBe(false);
    await setSurveyOpen(true);
    expect(currentLedger().surveyOpen).toBe(true);
  });

  it("rejects an incorrect admin secret", async () => {
    harness.adminSecret = WRONG_ADMIN_SECRET;
    await expect(setSurveyOpen(false)).rejects.toThrow(
      "only the admin can open or close the survey",
    );
    expect(currentLedger().surveyOpen).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. submitFeedback — the core privacy circuit
// ---------------------------------------------------------------------------

describe("submitFeedback circuit", () => {
  it("accepts a registered respondent and commits tally, nullifier and comment commitment", async () => {
    await registerAsAdmin(commitmentOf(ALICE));
    harness.secret = ALICE;
    harness.rating = 4n;
    const comment = new Uint8Array(32).fill(0x55);
    harness.comment = comment;

    const results = await submitFeedback();
    const l = currentLedger();

    // Public tally: exactly one bucket moved by one.
    expect(l.responseCount).toBe(1n);
    expect(l.participantCount).toBe(1n);
    expect(l.rating4).toBe(1n);
    expect(l.rating1 + l.rating2 + l.rating3 + l.rating5).toBe(0n);

    // Exactly one nullifier, derived from secret + contract address.
    const nullifier = nullifierOf(ALICE);
    expect(l.usedNullifiers.size()).toBe(1n);
    expect(l.usedNullifiers.member(nullifier)).toBe(true);

    // Comment commitment: keyed by the nullifier, value is the tagged hash —
    // never the plaintext.
    expect(l.commentCommitments.member(nullifier)).toBe(true);
    expect(Array.from(l.commentCommitments.lookup(nullifier))).toEqual(
      Array.from(commentCommitmentOf(comment)),
    );
    expect(Array.from(l.commentCommitments.lookup(nullifier))).not.toEqual(
      Array.from(comment),
    );

    // Proof data was produced for the call.
    const trace = results.context.callProofDataTrace;
    expect(trace).toHaveLength(1);
    expect(trace[0].circuitId).toBe("submitFeedback");
    expect(trace[0].contractAddress).toBe(ADDRESS);
    expect(trace[0].privateTranscriptOutputs).toHaveLength(4); // secret, rating, comment, merkle path
    expect(trace[0].publicTranscript.length).toBeGreaterThan(0);
    expect(trace[0].finalQueryContext).toBeDefined();
  });

  it("rejects an unregistered participant whose Merkle path is not in the tree", async () => {
    await registerAsAdmin(commitmentOf(ALICE));
    harness.secret = MALLORY; // commitment never registered
    harness.pathMode = "fabricated"; // self-consistent path, but bogus root

    await expect(submitFeedback()).rejects.toThrow(
      "not a registered respondent for this survey",
    );
    const l = currentLedger();
    expect(l.responseCount).toBe(0n);
    expect(l.usedNullifiers.size()).toBe(0n);
    expect(l.commentCommitments.isEmpty()).toBe(true);
    expect(l.rating1 + l.rating2 + l.rating3 + l.rating4 + l.rating5).toBe(0n);
  });

  it("rejects a duplicate submission via the spent nullifier", async () => {
    await registerAsAdmin(commitmentOf(ALICE));
    harness.secret = ALICE;
    await submitFeedback();
    expect(currentLedger().responseCount).toBe(1n);

    harness.rating = 2n; // different rating must not matter
    await expect(submitFeedback()).rejects.toThrow(
      "this respondent has already submitted feedback",
    );
    const l = currentLedger();
    expect(l.responseCount).toBe(1n); // no double count
    expect(l.usedNullifiers.size()).toBe(1n); // no second nullifier
    expect(l.rating2).toBe(0n); // second rating never tallied
    expect(l.rating4).toBe(1n);
    expect(l.commentCommitments.size()).toBe(1n);
  });

  it("rejects ratings outside 1-5 without committing any partial state", async () => {
    await registerAsAdmin(commitmentOf(ALICE));
    harness.secret = ALICE;

    harness.rating = 0n;
    await expect(submitFeedback()).rejects.toThrow("rating must be between 1 and 5");
    let l = currentLedger();
    // The circuit increments the nullifier before the rating check, but a
    // rejected call commits nothing: the pre-call state is what remains.
    expect(l.responseCount).toBe(0n);
    expect(l.usedNullifiers.size()).toBe(0n);
    expect(l.commentCommitments.isEmpty()).toBe(true);

    harness.rating = 6n;
    await expect(submitFeedback()).rejects.toThrow("rating must be between 1 and 5");
    l = currentLedger();
    expect(l.responseCount).toBe(0n);
    expect(l.usedNullifiers.size()).toBe(0n);

    // After two rejected attempts the same respondent can still submit a
    // valid rating — proving the failed calls spent nothing.
    harness.rating = 3n;
    await submitFeedback();
    l = currentLedger();
    expect(l.responseCount).toBe(1n);
    expect(l.rating3).toBe(1n);
    expect(l.usedNullifiers.size()).toBe(1n);
  });

  it("rejects submissions while the survey is closed and accepts them after reopening", async () => {
    await registerAsAdmin(commitmentOf(BOB));
    await setSurveyOpen(false);

    harness.secret = BOB;
    await expect(submitFeedback()).rejects.toThrow(
      "the survey is not currently accepting responses",
    );
    expect(currentLedger().responseCount).toBe(0n);
    expect(currentLedger().usedNullifiers.size()).toBe(0n);

    await setSurveyOpen(true);
    await submitFeedback();
    expect(currentLedger().responseCount).toBe(1n);
    expect(currentLedger().usedNullifiers.member(nullifierOf(BOB))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Privacy/security regressions for the Step 1 fixes
// ---------------------------------------------------------------------------

describe("privacy/security regressions (Step 1 fixes)", () => {
  it("rejects a Merkle path whose leaf does not match the commitment derived from the secret", async () => {
    await registerAsAdmin(commitmentOf(ALICE));
    harness.secret = ALICE; // registered...
    harness.pathMode = "tampered"; // ...but the path's leaf byte is flipped

    await expect(submitFeedback()).rejects.toThrow(
      "the Merkle path does not match this participant's commitment",
    );
    expect(currentLedger().responseCount).toBe(0n);
    expect(currentLedger().usedNullifiers.size()).toBe(0n);
  });

  it("rejects an incorrect secret presented together with another participant's genuine Merkle path", async () => {
    // The bug the reference model previously masked: without the leaf-binding
    // assert, Mallory could pair Alice's valid path (root still matches the
    // public tree) with her own unrelated secret and pass membership.
    await registerAsAdmin(commitmentOf(ALICE));
    harness.secret = MALLORY; // unregistered secret of the attacker
    harness.pathMode = "victim"; // hands the circuit Alice's genuine path
    harness.victimLeaf = commitmentOf(ALICE);

    await expect(submitFeedback()).rejects.toThrow(
      "the Merkle path does not match this participant's commitment",
    );
    const l = currentLedger();
    expect(l.responseCount).toBe(0n);
    expect(l.usedNullifiers.size()).toBe(0n);
    expect(l.commentCommitments.isEmpty()).toBe(true);
  });

  it("cannot even build an honest witness path for an unregistered secret", async () => {
    await registerAsAdmin(commitmentOf(ALICE));
    harness.secret = MALLORY;
    harness.pathMode = "honest";

    await expect(submitFeedback()).rejects.toThrow(
      "no Merkle path for leaf: secret is not a registered respondent",
    );
    expect(currentLedger().responseCount).toBe(0n);
  });

  it("keeps nullifiers domain-separated, contract-scoped, and never stores comment plaintext", async () => {
    await registerAsAdmin(commitmentOf(ALICE));
    harness.secret = ALICE;
    const comment = new Uint8Array(32).fill(0x42);
    harness.comment = comment;
    await submitFeedback();

    const l = currentLedger();
    const nullifier = nullifierOf(ALICE);

    // Nullifier != commitment: same secret, different domain tag.
    expect(nullifier).not.toEqual(commitmentOf(ALICE));
    expect(l.usedNullifiers.member(nullifier)).toBe(true);
    expect(l.usedNullifiers.member(commitmentOf(ALICE))).toBe(false);

    // Nullifier is scoped by this contract instance's address: the same secret
    // under a different address derives a different nullifier, so responses
    // cannot be linked across deployments.
    const otherAddress = new Uint8Array(32).fill(0xee);
    expect(nullifierOf(ALICE, otherAddress)).not.toEqual(nullifier);
    expect(l.usedNullifiers.member(nullifierOf(ALICE, otherAddress))).toBe(false);

    // The stored comment commitment is a hash, not the plaintext.
    const stored = l.commentCommitments.lookup(nullifier);
    expect(Array.from(stored)).toEqual(Array.from(commentCommitmentOf(comment)));
    expect(stored).not.toEqual(comment);
    // The secret itself is never written to the public ledger surface.
    expect(l.usedNullifiers.member(ALICE)).toBe(false);
    expect(l.participants.findPathForLeaf(ALICE)).toBeUndefined();
  });
});
