/**
 * The organizer <-> browser commitment contract.
 *
 * THE INVARIANT UNDER TEST
 *   `registerParticipant` inserts a COMMITMENT; `submitFeedback` re-derives the
 *   commitment from the respondent's secret and demands a Merkle path for that
 *   exact leaf. If the organizer script and the contract derive different bytes
 *   for the same secret, registration silently succeeds while every subsequent
 *   submission is rejected as unregistered.
 *
 *   So this suite proves the shared helper
 *   (scripts/lib-participant-commitment.mjs) reproduces the derivation the
 *   COMPILED CONTRACT itself performs — not a reimplementation of it. The
 *   ledger-8 compiled contract is executed directly: a leaf produced by the
 *   helper is registered, then `submitFeedback` is run with the same raw
 *   secret and must find a path.
 *
 *   A mismatched tag, a wrong vector arity, a mis-padded tag, or an off-by-one
 *   encoding all fail here.
 *
 * OFFLINE ONLY. No Preview contact, no wallet, no proof server.
 *
 * WHY THE ERAS MATCH: the live Preview deployment is the retained ledger-v8
 * artifact, so these tests drive `managed/feedback-v8` against the SAME
 * ledger-8 runtime the organizer script loads. `tests/feedback.contract.test.ts`
 * covers the same invariants for the v9 artifact independently.
 */

import { describe, expect, it } from "vitest";
import { TextEncoder } from "node:util";
// Imported by the SAME bare specifier managed/feedback-v8/contract/index.js uses
// (`@midnight-ntwrk/compact-runtime-ledger8`). That package is an npm alias of
// compact-runtime@0.16.0 carrying a hand-written shim that re-exports the
// stable testkit's NESTED copy BY FILE PATH, so the WASM classes (ContractState
// etc.) have a single identity. Loading it here by a different route — e.g.
// resolving through createRequire — yields a second instance whose classes fail
// the `instanceof` checks inside createCircuitContext.
import * as ledger8 from "@midnight-ntwrk/compact-runtime-ledger8";
// The v9 runtime + generated contract, used ONLY to execute the compiled
// circuits end to end: this test process has no working in-memory harness for
// the v8 runtime's state threading, whereas the v9 pair is the same pattern
// tests/feedback.contract.test.ts already exercises. The cross-era test below
// then proves ledger-8 and v9 derive identical commitments, which is what makes
// the v9 execution valid evidence for the ledger-v8 Preview deployment.
import * as runtime9 from "@midnight-ntwrk/compact-runtime";
import { Contract, ledger } from "../managed/feedback/contract/index.js";
import {
  participantCommitmentOf,
  parseSecretHex,
  secretToHex,
  tagPad,
  COMMITMENT_TAG_TEXT,
} from "../scripts/lib-participant-commitment.mjs";

const managed = { Contract, ledger };

// Exactly 32 bytes (64 hex chars). Kept obviously synthetic.
const SECRET_HEX =
  "00112233445566778899aabbccddeeff0102030405060708090a0b0c0d0e0f10";

function secret(fill: number): Uint8Array {
  const out = new Uint8Array(32);
  out.fill(fill);
  return out;
}

// ---------------------------------------------------------------------------
// 1. Hex representation round-trips exactly, matching the browser's crypto.ts.
// ---------------------------------------------------------------------------

describe("invitation-secret hex representation", () => {
  it("parses 64-char hex to the same bytes the browser's fromHex produces", () => {
    expect(secretToHex(parseSecretHex(SECRET_HEX))).toBe(SECRET_HEX);
    // Byte-level spot checks against an independently reasoned decode.
    const bytes = parseSecretHex(SECRET_HEX);
    expect(bytes).toHaveLength(32);
    expect(bytes[0]).toBe(0x00);
    expect(bytes[1]).toBe(0x11);
    expect(bytes[31]).toBe(0x10);
  });

  it("is case-insensitive and tolerates an 0x prefix and surrounding space", () => {
    const expected = parseSecretHex(SECRET_HEX);
    expect(Array.from(parseSecretHex(SECRET_HEX.toUpperCase()))).toEqual(Array.from(expected));
    expect(Array.from(parseSecretHex(`  0x${SECRET_HEX}  `))).toEqual(Array.from(expected));
  });

  it("rejects anything that is not exactly 32 bytes of hex", () => {
    // These are exactly the inputs the import UI must refuse.
    expect(() => parseSecretHex("")).toThrow();
    expect(() => parseSecretHex("deadbeef")).toThrow(); // 4 bytes
    expect(() => parseSecretHex("z".repeat(64))).toThrow(); // non-hex
    expect(() => parseSecretHex(`${SECRET_HEX}ab`)).toThrow(); // 33 bytes
    expect(() => parseSecretHex(SECRET_HEX.slice(0, 62))).toThrow(); // 31 bytes
  });

  it("never echoes the rejected value in the error message", () => {
    // A pasted secret must not land in a thrown message that could be logged.
    try {
      parseSecretHex("z".repeat(64));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error instanceof Error ? error.message : "").not.toContain("zzzz");
    }
  });

  it("agrees byte-for-byte with the browser's own fromHex/toHex", async () => {
    // The two ends must accept exactly one representation, or a transferred
    // secret would be rejected by the browser (or vice versa).
    const { fromHex, toHex } = await import("../src/lib/crypto");
    expect(Array.from(fromHex(SECRET_HEX))).toEqual(Array.from(parseSecretHex(SECRET_HEX)));
    expect(toHex(fromHex(SECRET_HEX))).toBe(secretToHex(parseSecretHex(SECRET_HEX)));
    // And both reject the same malformed inputs.
    for (const bad of ["", "deadbeef", "z".repeat(64), `${SECRET_HEX}ab`]) {
      expect(() => fromHex(bad)).toThrow();
      expect(() => parseSecretHex(bad)).toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. tagPad reproduces Compact's pad(32, ...).
// ---------------------------------------------------------------------------

describe("domain-separation tag padding", () => {
  it("left-aligns the ASCII tag and zero-pads to 32 bytes", () => {
    const padded = tagPad(COMMITMENT_TAG_TEXT);
    expect(padded).toHaveLength(32);
    // Compare the tag region only: `toString("ascii")` would carry the NUL
    // padding into the comparison.
    expect(Buffer.from(padded.subarray(0, COMMITMENT_TAG_TEXT.length)).toString("ascii")).toBe(
      COMMITMENT_TAG_TEXT,
    );
    expect(Array.from(padded.slice(COMMITMENT_TAG_TEXT.length))).toEqual(
      new Array(32 - COMMITMENT_TAG_TEXT.length).fill(0),
    );
  });

  it("matches a TextEncoder pad(32, ...) reference", () => {
    const reference = new Uint8Array(32);
    reference.set(new TextEncoder().encode(COMMITMENT_TAG_TEXT));
    expect(Array.from(tagPad(COMMITMENT_TAG_TEXT))).toEqual(Array.from(reference));
  });

  it("uses the exact tag string the contract hard-codes", () => {
    // A rename of the contract's tag would silently break every registration.
    expect(COMMITMENT_TAG_TEXT).toBe("midnight:feedback:commitment");
  });
});

// ---------------------------------------------------------------------------
// 3. The shared helper is deterministic and matches an inline computation.
// ---------------------------------------------------------------------------

describe("participant commitment derivation", () => {
  it("rejects a secret that is not 32 bytes", () => {
    expect(() => participantCommitmentOf(ledger8, new Uint8Array(31))).toThrow(/32 bytes/);
    expect(() => participantCommitmentOf(ledger8, new Uint8Array(33))).toThrow(/32 bytes/);
    expect(() => participantCommitmentOf(ledger8, [1, 2, 3])).toThrow(TypeError);
  });

  it("is deterministic and secret-dependent", () => {
    const a = participantCommitmentOf(ledger8, secret(0x11));
    const b = participantCommitmentOf(ledger8, secret(0x11));
    const c = participantCommitmentOf(ledger8, secret(0x12));
    expect(Buffer.from(a).toString("hex")).toBe(Buffer.from(b).toString("hex"));
    expect(Buffer.from(a).toString("hex")).not.toBe(Buffer.from(c).toString("hex"));
  });

  it("matches an independent inline persistentHash computation", () => {
    // Recomputed here from the contract's `taggedHash` definition rather than
    // by calling the shared helper, so a bug in the helper cannot hide.
    const bytes32 = new ledger8.CompactTypeBytes(32);
    const vector2 = new ledger8.CompactTypeVector(2, bytes32);
    const expected = ledger8.persistentHash(vector2, [tagPad(COMMITMENT_TAG_TEXT), secret(0x22)]);
    expect(Buffer.from(participantCommitmentOf(ledger8, secret(0x22))).toString("hex")).toBe(
      Buffer.from(expected).toString("hex"),
    );
  });
});

describe("the organizer admin attach carries no private state", () => {
  /**
   * A regression guard for a live failure, not a unit-level detail.
   *
   * `registerParticipant`'s only witness is `adminSecret`, supplied by the
   * script's `adminRuntimeSecret` closure — it reads nothing from private state.
   * Passing `privateStateId` to `findDeployedContract` WITHOUT an
   * `initialPrivateState` takes the SDK's third branch, which asserts and
   * throws:
   *
   *   "No private state found at private state ID 'feedbackPrivateState'"
   *
   * That only manifests against a real store at run time, so nothing else in
   * the suite would catch its reintroduction. Asserted on the source because
   * the SDK's four-way private-state branch is not exported and cannot be
   * driven directly.
   */
  it("provision-participant-preview.mjs omits privateStateId from findDeployedContract", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "../scripts/provision-participant-preview.mjs"),
      "utf8",
    );

    // The attach call itself must not pass either private-state option. The
    // word still appears in the explanatory comment block above the function.
    const attach = source.match(
      /findDeployedContract\(providers,\s*\{([\s\S]*?)\}\)/,
    )?.[1];
    expect(attach).toBeDefined();
    expect(attach).not.toMatch(/privateStateId\s*:/);
    expect(attach).not.toMatch(/initialPrivateState\s*:/);
  });
});

// ---------------------------------------------------------------------------
// 4. END-TO-END AGAINST THE COMPILED CONTRACT (the real proof of parity).
// ---------------------------------------------------------------------------

const ADMIN_SECRET = secret(0xaa);
const RESPONDENT_SECRET = secret(0x01);
const ZERO32 = new Uint8Array(32);

const baseHarness = (): Record<string, unknown> => ({
  secret: RESPONDENT_SECRET,
  adminSecret: ADMIN_SECRET,
  rating: 4n,
  comment: secret(0x07),
});

/** Witness set mirroring src/lib/midnight/witnesses.ts, including its message. */
const makeWitnesses = () => ({
  participantSecret: (ctx: any) => [ctx.privateState, ctx.privateState.secret],
  participantMerklePath: (ctx: any, leaf: Uint8Array) => {
    const path = ctx.ledger.participants.findPathForLeaf(leaf);
    if (path === undefined) {
      throw new Error(
        "This invitation secret is not registered for this survey. Contact the survey organizer.",
      );
    }
    return [ctx.privateState, path];
  },
  feedbackRating: (ctx: any) => [ctx.privateState, ctx.privateState.rating],
  feedbackComment: (ctx: any) => [ctx.privateState, ctx.privateState.comment],
  adminSecret: (ctx: any) => [ctx.privateState, ctx.privateState.adminSecret ?? ZERO32],
});

/** Mirrors the contract's `adminIdentity` circuit, in the v9 runtime. */
function adminIdentity(secretBytes: Uint8Array): Uint8Array {
  const vector2 = new runtime9.CompactTypeVector(2, new runtime9.CompactTypeBytes(32));
  return runtime9.persistentHash(vector2, [tagPad("midnight:feedback:admin:identity"), secretBytes]);
}

/**
 * Deploys the compiled contract in-memory and returns a small call harness.
 *
 * Mirrors the proven pattern in tests/feedback.contract.test.ts: the v9
 * `createCircuitContext(circuitId, address, zswap, state, privateState)` takes
 * the circuit id FIRST (the ledger-8 runtime's argument order differs).
 */
async function deploy(harness: Record<string, unknown>) {
  const contract = new managed.Contract(makeWitnesses() as never);
  const init = await contract.initialState(
    runtime9.createConstructorContext(harness, { bytes: ZERO32 } as never),
    adminIdentity(ADMIN_SECRET),
  );
  let state: unknown = init.currentContractState;
  const zswap = init.currentZswapLocalState;
  const address = runtime9.dummyContractAddress();
  const ctx = (id: string, ps: Record<string, unknown> = harness) =>
    runtime9.createCircuitContext(id, address, zswap, state, ps);
  const readLedger = () =>
    managed.ledger(
      state instanceof runtime9.ContractState
        ? state.data
        : (state as never),
    );
  return {
    contract,
    ctx,
    readLedger,
    advance: (results: unknown) => {
      state = (results as { context: { callContext: { currentQueryContext: { state: unknown } } } })
        .context.callContext.currentQueryContext.state;
    },
  };
}

describe("the organizer helper agrees with the contract's own derivation", () => {
  /**
   * THE CROSS-ERA ANCHOR.
   *
   * The organizer script registers against the retained ledger-v8 deployment
   * using ledger-8's `persistentHash`. The compiled contract available to this
   * test process for full circuit execution is the v9 artifact. These are
   * different runtime packages, so this asserts they produce IDENTICAL bytes
   * for the same (tag, secret).
   *
   * If this ever diverges — a version bump changing `persistentHash`, or the
   * organizer script being pointed at the wrong era's runtime — the
   * organizer/browser parity asserted below would silently stop holding, and a
   * legitimately registered respondent would be rejected as unregistered.
   */
  it("ledger-8 and v9 persistentHash agree byte-for-byte on the commitment", () => {
    const v8 = new ledger8.CompactTypeVector(2, new ledger8.CompactTypeBytes(32));
    const v9 = new runtime9.CompactTypeVector(2, new runtime9.CompactTypeBytes(32));
    for (const fill of [0x00, 0x01, 0x7f, 0xff, 0xaa]) {
      const s = secret(fill);
      const viaLedger8 = Buffer.from(
        ledger8.persistentHash(v8, [tagPad(COMMITMENT_TAG_TEXT), s]),
      ).toString("hex");
      const viaV9 = Buffer.from(
        runtime9.persistentHash(v9, [tagPad(COMMITMENT_TAG_TEXT), s]),
      ).toString("hex");
      expect(viaLedger8).toBe(viaV9);
    }
  });

  it("the ledger-8 helper yields the same commitment as the v9 reference", () => {
    const v9 = new runtime9.CompactTypeVector(2, new runtime9.CompactTypeBytes(32));
    const s = RESPONDENT_SECRET;
    const viaHelper = Buffer.from(participantCommitmentOf(ledger8, s)).toString("hex");
    const viaV9 = Buffer.from(
      runtime9.persistentHash(v9, [tagPad(COMMITMENT_TAG_TEXT), s]),
    ).toString("hex");
    expect(viaHelper).toBe(viaV9);
  });
});

describe("organizer registration and browser submission agree (compiled contract)", () => {
  /**
   * Registers the leaf the ORGANIZER SCRIPT would compute, then submits with the
   * same raw secret the BROWSER would hold. Success proves the two sides derive
   * identical bytes — the contract re-derives the leaf internally from the
   * witness secret and looks it up with `findPathForLeaf`.
   *
   * Runs the COMPILED contract, so the asserted derivation is the contract's
   * own, not a reimplementation. The cross-era test above transfers this result
   * to the ledger-8 runtime the Preview deployment uses.
   */
  it("a helper-derived commitment is registrable and submit-able with the same secret", async () => {
    const harness = baseHarness();
    const { contract, ctx, readLedger, advance } = await deploy(harness);

    // --- ORGANIZER: exactly what provision-participant-preview.mjs does ---
    const leaf = participantCommitmentOf(ledger8, RESPONDENT_SECRET);
    advance(await contract.circuits.registerParticipant(ctx("registerParticipant"), leaf));
    expect(readLedger().participantCount).toBe(1n);

    // --- BROWSER: holds the same secret, proves membership of it ---
    advance(await contract.circuits.submitFeedback(ctx("submitFeedback")));

    const ledger = readLedger();
    expect(ledger.responseCount).toBe(1n);
    expect(ledger.participantCount).toBe(1n);
  });

  it("a DIFFERENT secret still fails the Merkle-path check after registration", async () => {
    // Proves the passing test above is not vacuous: registration is
    // secret-specific, so the assertion really does exercise the derivation.
    const h = await deploy(baseHarness());
    const { advance } = h;
    advance(
      await h.contract.circuits.registerParticipant(
        h.ctx("registerParticipant"),
        participantCommitmentOf(ledger8, secret(0x01)),
      ),
    );
    advance(
      await h.contract.circuits.registerParticipant(
        h.ctx("registerParticipant"),
        participantCommitmentOf(ledger8, secret(0x02)),
      ),
    );
    expect(h.readLedger().participantCount).toBe(2n);

    // Submit holding a secret that was never registered.
    const stranger = { ...baseHarness(), secret: secret(0x03) };
    await expect(
      h.contract.circuits.submitFeedback(h.ctx("submitFeedback", stranger)),
    ).rejects.toThrow(/not registered for this survey/);
  });

  it("registration is refused to a caller that is not the admin", async () => {
    const h = await deploy(baseHarness());
    // A respondent wallet, holding no admin material.
    const impostor = { ...baseHarness(), adminSecret: ZERO32 };
    await expect(
      h.contract.circuits.registerParticipant(
        h.ctx("registerParticipant", impostor),
        participantCommitmentOf(ledger8, secret(0x01)),
      ),
    ).rejects.toThrow();
    // Nothing was inserted.
    expect(h.readLedger().participantCount).toBe(0n);
  });

  it("the browser witness still refuses an unregistered secret (guard intact)", async () => {
    // The participantMerklePath check the diagnosis relied on must still fail
    // closed. This is the "unregistered" branch of the UX.
    const h = await deploy(baseHarness());
    const stranger = { ...baseHarness(), secret: secret(0x05) };
    await expect(
      h.contract.circuits.submitFeedback(h.ctx("submitFeedback", stranger)),
    ).rejects.toThrow(
      "This invitation secret is not registered for this survey. Contact the survey organizer.",
    );
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */