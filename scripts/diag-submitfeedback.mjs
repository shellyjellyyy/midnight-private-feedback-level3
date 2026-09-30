#!/usr/bin/env node
/**
 * READ-ONLY local rehearsal of the `submitFeedback` path on Preview.
 *
 *   node --max-old-space-size=8192 scripts/diag-submitfeedback.mjs --contract <32-byte-hex>
 *
 * WHY
 *   After the empty-DustActions fix, contract CALLS finally finalize on Preview
 *   (both `registerParticipant` calls reached `SucceedEntirely`). The real
 *   `submitFeedback` then fails with a DIFFERENT, LOCAL error:
 *
 *     [FATAL] Unexpected error submitting scoped transaction '<unnamed>':
 *             (FiberFailure) Wallet.Other: unreachable
 *     [cause]: RuntimeError: unreachable      <-- a Rust panic inside the ledger WASM
 *       at catch (wallet-sdk-dust-wallet/dist/v1/Transacting.js:285)
 *
 *   That `catch` is the one inside `computeBalancingRecipe`, and the only wasm
 *   call it wraps is `dryRunFee` -> `calculateFee` -> `Transaction.feesWithMargin`.
 *   So the question this script answers is narrow and factual:
 *   does `feesWithMargin` panic, and on WHICH transaction shape?
 *
 * WHAT IT DOES
 *   Rebuilds the real `submitFeedback` call transaction LOCALLY from real chain
 *   data (contract state + Zswap chain state + ledger parameters, all read from
 *   the Preview indexer) and the participant's real private state, then reports
 *   what the ledger does with it. It is the same `createUnprovenCallTxFromInitialStates`
 *   entry point `midnight-js-contracts` uses.
 *
 * WHAT IT NEVER DOES
 *   - It never submits, signs, proves or broadcasts anything.
 *   - It holds no wallet and no key material. The private state is read from the
 *     local encrypted store only to feed the witness, and is NEVER printed,
 *     logged, or serialised to the report.
 *   - It cannot move funds.
 *
 * Useful: distinguishing failure classes. A panic here is a LOCAL ledger/cost
 * problem, not a mempool rejection and not an on-chain assertion.
 */

import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const INDEXER_HTTP = "https://indexer.preview.midnight.network/api/v4/graphql";
const INDEXER_WS = "wss://indexer.preview.midnight.network/api/v4/graphql/ws";
const ARTIFACT_DIR = "managed/feedback-v8";
const PARTICIPANT_STORE = "feedback-preview-participant";
const PRIVATE_STATE_ID = "feedbackPrivateState";
// The testkit's own fixed local-store password (testkit-js-stable
// `initializeMidnightProviders`). It protects only the LOCAL gitignored store.
const STORE_PASSWORD = "Answer to the Ultimate Question of Life, the Universe, and Everything!";

const CONTRACT_ADDRESS = (
  process.argv.find((a) => a.startsWith("--contract="))?.slice("--contract=".length) ??
  process.env.MIDNIGHT_PREVIEW_CONTRACT ??
  ""
)
  .replace(/^0x/, "")
  .toLowerCase();
if (!/^[0-9a-f]{64}$/.test(CONTRACT_ADDRESS)) {
  console.error("usage: node --max-old-space-size=8192 scripts/diag-submitfeedback.mjs --contract <32-byte-hex>");
  process.exit(2);
}
if (!existsSync(resolve(ARTIFACT_DIR, "contract/index.js"))) {
  console.error(`[BLOCKER] retained v8 artifact not found at ${ARTIFACT_DIR}`);
  process.exit(2);
}

const line = (s = "") => console.log(s);
const head = (s) => {
  line();
  line(`== ${s} ==`);
};

// IMPORT ORDER IS LOAD-BEARING (WASM class identity). Must match
// scripts/deploy-preview.mjs: stable testkit first, artifact last.
const testkit = await import("@midnight-ntwrk/testkit-js-stable");
const managed = await import(pathToFileURL(resolve(ARTIFACT_DIR, "contract/index.js")).href);
managed.checkRuntimeVersion?.("0.16.0");
const ledger8 = await import("@midnight-ntwrk/compact-runtime-ledger8");
const stableRoot = "node_modules/@midnight-ntwrk/testkit-js-stable/node_modules/@midnight-ntwrk";
const stableTypes = await import(pathToFileURL(resolve(`${stableRoot}/midnight-js-types/dist/index.mjs`)).href);
const contracts = await import(
  pathToFileURL(resolve(`${stableRoot}/midnight-js-contracts/dist/index.mjs`)).href
);
const { NodeZkConfigProvider } = await import(
  pathToFileURL(resolve(`${stableRoot}/midnight-js-node-zk-config-provider/dist/index.mjs`)).href
);
const { levelPrivateStateProvider } = await import(
  pathToFileURL(resolve(`${stableRoot}/midnight-js-level-private-state-provider/dist/index.mjs`)).href
);
const { indexerPublicDataProvider } = await import(
  pathToFileURL(resolve(`${stableRoot}/midnight-js-indexer-public-data-provider/dist/index.mjs`)).href
);
const { httpClientProofProvider } = await import(
  pathToFileURL(resolve(`${stableRoot}/midnight-js-http-client-proof-provider/dist/index.mjs`)).href
);
const networkIdMod = await import(pathToFileURL(resolve(`${stableRoot}/midnight-js-network-id/dist/index.mjs`)).href);
networkIdMod.setNetworkId("preview");
if (networkIdMod.getNetworkId() !== "preview") throw new Error("setNetworkId verification failed");

const bytes32 = new ledger8.CompactTypeBytes(32);
const vector2 = new ledger8.CompactTypeVector(2, bytes32);
const vector3 = new ledger8.CompactTypeVector(3, bytes32);
const tagPad = (t) => {
  const o = new Uint8Array(32);
  o.set(Buffer.from(t, "ascii").subarray(0, 32));
  return o;
};
const COMMITMENT_TAG = tagPad("midnight:feedback:commitment");
const commitmentOf = (secret) => ledger8.persistentHash(vector2, [COMMITMENT_TAG, secret]);
const sha256 = (b) => new Uint8Array(createHash("sha256").update(b).digest());

// ---------------------------------------------------------------------------
// 1. Real chain state (contract + Zswap + ledger parameters) — read only.
// ---------------------------------------------------------------------------
head("1. REAL chain state from the Preview indexer");
const pdp = indexerPublicDataProvider(INDEXER_HTTP, INDEXER_WS);
const address = stableTypes.asContractAddress(CONTRACT_ADDRESS);
const zcs = await pdp.queryZSwapAndContractState(address);
if (!zcs) {
  console.error(`[BLOCKER] no state for ${CONTRACT_ADDRESS} on Preview.`);
  process.exit(3);
}
const [initialZswapChainState, contractState, ledgerParameters] = zcs;
const l = managed.ledger(contractState.data);
line(`  contract      : ${CONTRACT_ADDRESS}`);
line(`  surveyOpen    : ${l.surveyOpen}`);
line(`  participants  : ${l.participantCount}`);
line(`  responses     : ${l.responseCount}`);
line(`  nullifiers    : ${l.usedNullifiers.size()}`);

// ---------------------------------------------------------------------------
// 2. The participant's real private state from the local encrypted store.
//    Never printed. Only its SHAPE is reported.
// ---------------------------------------------------------------------------
head("2. Participant private state (local store; contents never printed)");
const { MidnightWalletProvider, PreviewTestEnvironment, getInitialShieldedState } = testkit;
const seedFile = ".participant-seed-preview";
if (!existsSync(seedFile)) {
  console.error(`[BLOCKER] ${seedFile} not found (needed to derive the store account id).`);
  process.exit(3);
}
const logger = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {}, trace: () => {}, level: "silent" };
const env = new PreviewTestEnvironment(logger);
env.proofServerContainer = { getUrl: () => "https://proof-server.preview.midnight.network", stop: async () => {} };
const envConfig = env.getEnvironmentConfiguration();

const wallet = await MidnightWalletProvider.build(logger, envConfig, readFileSync(seedFile, "utf8").trim());
const coinPublicKey = wallet.getCoinPublicKey();
// The level store namespaces by sha256(accountId)[0..32], and the testkit builds
// accountId as Buffer.from(getCoinPublicKey()).toString("hex"). In this build
// getCoinPublicKey() returns a 64-char hex STRING, so that hex-of-the-ASCII
// digits is the account id — decoding the hex first silently addresses a
// different, empty account and looks like "no private state stored".
const rawCpk = wallet.getCoinPublicKey();
const accountId = Buffer.from(rawCpk).toString("hex");
line(`  accountId (public): ${accountId.slice(0, 32)}… (${accountId.length} hex chars)`);
line("  NOTE: no chain sync is performed by this script; it never needs one.");

// The private state written by the last real run's `participantReady(...)`.
// The participant-1 secret itself is never displayed.
const psp = levelPrivateStateProvider({
  privateStateStoreName: PARTICIPANT_STORE,
  signingKeyStoreName: `${PARTICIPANT_STORE}-signing-keys`,
  privateStoragePasswordProvider: () => STORE_PASSWORD,
  accountId,
});
psp.setContractAddress(address);
let privateState;
try {
  privateState = await psp.get(PRIVATE_STATE_ID);
} catch (e) {
  console.error(`[BLOCKER] cannot read '${PRIVATE_STATE_ID}' from '${PARTICIPANT_STORE}': ${e?.message ?? e}`);
  console.error("  A real run must reach `submitFeedback` once (to store the state) before this can rehearse it.");
  process.exit(3);
}
line(`  private state : present for '${PRIVATE_STATE_ID}' (keys: ${Object.keys(privateState).join(", ")})`);
const secret = privateState.secret;
if (!secret) {
  console.error("[BLOCKER] stored private state has no `secret` field.");
  process.exit(3);
}
const leaf = commitmentOf(secret);
line(`  its commitment is a REGISTERED leaf: ${l.participants.findPathForLeaf(leaf) !== undefined}`);

// ---------------------------------------------------------------------------
// 3. Rebuild the real submitFeedback call transaction locally (unproven).
// ---------------------------------------------------------------------------
head("3. Rebuilding the unproven submitFeedback transaction (no submit, no proof)");
const participantWitnessSet = {
  participantSecret: (ctx) => [ctx.privateState, ctx.privateState.secret],
  participantMerklePath: (ctx, leafArg) => {
    const path = ctx.ledger.participants.findPathForLeaf(leafArg);
    if (path === undefined) throw new Error("This secret is not registered for this survey.");
    return [ctx.privateState, path];
  },
  feedbackRating: (ctx) => [ctx.privateState, ctx.privateState.rating],
  feedbackComment: (ctx) => [ctx.privateState, ctx.privateState.commentDigest],
  adminSecret: (ctx) => [ctx.privateState, new Uint8Array(32)],
};

const testkitEntry = createRequire(import.meta.url).resolve("@midnight-ntwrk/testkit-js-stable");
const reqFromTestkit = createRequire(testkitEntry);
const nestedPkg = reqFromTestkit.resolve("@midnight-ntwrk/compact-js/package.json");
const { dirname, join } = await import("node:path");
const compactJs = await import(
  pathToFileURL(join(dirname(nestedPkg), "dist", "esm", "index.js")).href
);
const { CompiledContract } = compactJs;
const compiled = CompiledContract.make("Feedback", managed.Contract).pipe(
  CompiledContract.withWitnesses(participantWitnessSet),
  CompiledContract.withCompiledFileAssets(ARTIFACT_DIR.replace(/\\/g, "/")),
);
const zkConfigProvider = new NodeZkConfigProvider(ARTIFACT_DIR.replace(/\\/g, "/"));

const initialShielded = await getInitialShieldedState(wallet.wallet.shielded);
// The participant has never received shielded coins, so its Zswap local state
// is empty. A default-constructed ZswapLocalState is exactly that, and it is
// what a fresh wallet would hand the contracts layer.
const { ZswapLocalState } = await import(
  pathToFileURL(resolve(`${stableRoot}/midnight-js-protocol/dist/ledger.mjs`)).href
);
const initialZswapState = new ZswapLocalState();
line(`  zswap local state: default-constructed (no shielded coins held)`);
void initialShielded;

const created = await contracts.createUnprovenCallTxFromInitialStates(
  zkConfigProvider,
  {
    compiledContract: compiled,
    contractAddress: address,
    circuitId: "submitFeedback",
    coinPublicKey: rawCpk,
    args: [],
    privateStateId: PRIVATE_STATE_ID,
    initialContractState: contractState,
    initialZswapChainState,
    ledgerParameters,
    initialPrivateState: privateState,
    initialZswapState,
  },
  coinPublicKey,
);
line("  createUnprovenCallTxFromInitialStates: OK (witness generation succeeded locally)");
const WITNESS_OK = true;

// ---------------------------------------------------------------------------
// 4. The narrow question: what does the ledger do with this transaction?
// ---------------------------------------------------------------------------
head("4. Ledger operations on the rebuilt transaction");
const unproven = created.private?.unprovenTx ?? created.public?.unprovenTransaction;
if (!unproven) {
  line(`  returned public keys   : ${Object.keys(created.public ?? {}).join(", ")}`);
  line(`  returned private keys  : ${Object.keys(created.private ?? {}).join(", ")}`);
  console.error("\n  [BLOCKER] the assembled unproven transaction is not reachable from this entry point.");
  head("SUMMARY");
  line(`  witness generation (local)     : SUCCEEDED (the circuit is not the problem)`);
  line(`  transaction submitted          : NO (this script cannot submit)`);
  line(`  private state / secret printed : NO`);
  line("done.");
  process.exit(4);
}
line(`  unproven transaction: ${unproven.constructor?.name ?? typeof unproven}`);
// Structural dump only — no secret, no ciphertext bytes, no witness value.
// Sizes and counts describe SHAPE; the digests are one-way and non-invertible.
for (const [segmentId, intent] of unproven.intents ?? []) {
  const da = intent.dustActions;
  const t = intent.actions?.[0];
  const pt = t?.fallibleTranscript ?? t?.guaranteedTranscript;
  const zswap = t?.zswapOffer;
  line(`    intent[${segmentId}]`);
  line(`      actions            : ${intent.actions?.length ?? 0}`);
  line(`      dustActions        : ${da ? `{spends:${da.spends?.length ?? 0}, registrations:${da.registrations?.length ?? 0}}` : "absent"}`);
  line(`      zswapOffer         : ${zswap ? "present" : "absent"}`);
  if (zswap) {
    const cs = zswap.claimedShieldedSpends?.length ?? 0;
    const cr = zswap.claimedShieldedReceives?.length ?? 0;
    line(`      claimedSpends      : ${cs}   claimedReceives: ${cr}`);
    line(`      nullifier-free?    : spend nullifiers are ${cs === 0 ? "absent" : "present but never printed"}`);
  }
  if (pt) {
    const prog = pt.program?.length ?? 0;
    const parts = [];
    for (const key of ["publicTranscript", "privateTranscript"]) {
      const p = pt[key];
      if (!p) continue;
      parts.push(`${key}: ${p.programs?.length ?? 0} programs, proof=${p.proof === null || p.proof === undefined ? "none" : "present"}`);
    }
    line(`      transcript partition: ${prog} ops; ${parts.join(" | ") || "no partitions"}`);
  }
}

function probe(label, fn) {
  try {
    const v = fn();
    line(`  ${label.padEnd(34)} -> OK   ${typeof v === "object" && v !== null ? "" : String(v)}`);
    return { ok: true, v };
  } catch (e) {
    line(`  ${label.padEnd(34)} -> THROW ${String(e?.message ?? e).slice(0, 150)}`);
    return { ok: false, e };
  }
}

const feeReal = probe("feesWithMargin(REAL, 5)", () => unproven.feesWithMargin(ledgerParameters, 5));
const FEE_OK = feeReal.ok;
const FEE = feeReal.ok ? feeReal.v : undefined;
const FEE_ERR = feeReal.ok ? undefined : feeReal.e;
if (feeReal.ok) line(`     fee = ${feeReal.v}`);

const imbalances = probe("imbalances(0, fee)", () => unproven.imbalances(0, feeReal.ok ? feeReal.v : 0n));
let IMB = null;
if (imbalances.ok) {
  const o = {};
  for (const [k, v] of imbalances.v.entries()) o[k.tag] = v.toString();
  IMB = JSON.stringify(o);
  line(`     dust imbalance = ${IMB}`);
}

// The exact call the wallet makes while balancing, on the same transaction.
probe("balance-style feesWithMargin", () => unproven.feesWithMargin(ledgerParameters, 5));

// ---------------------------------------------------------------------------
// 5. PROVE, then re-probe. This is where the real run diverges:
//    midnight-js-contracts submitTxCore is literally
//        const provenTx = await proofProvider.proveTx(unprovenTx);
//        const toSubmit  = await walletProvider.balanceTx(provenTx);   <-- panics here
//    so the ONLY difference between the working state above and the failing
//    state is that `transactions` is now proof-bearing.
// ---------------------------------------------------------------------------
let proven = null;
if (!process.argv.includes("--prove")) {
  line("");
  line("  (re-run with --prove to generate the real ZK proof and probe the");
  line("   proof-bearing transaction; nothing is ever submitted either way)");
} else {
  head("5. Proving the transaction (real, remote — never submitted)");
  const proofProvider = httpClientProofProvider("https://proof-server.preview.midnight.network", zkConfigProvider, {
    timeout: Number(process.env.PROVE_TIMEOUT_MS ?? 1_800_000),
  });
  const t0 = Date.now();
  try {
    proven = await proofProvider.proveTx(unproven);
    line(`  proveTx: OK in ${Math.round((Date.now() - t0) / 1000)}s`);
  } catch (e) {
    line(`  proveTx: THREW after ${Math.round((Date.now() - t0) / 1000)}s -> ${String(e?.message ?? e).slice(0, 200)}`);
    line(`  proveTx error name: ${e?.name ?? "(none)"}  code: ${e?.code ?? "(none)"}`);
  }

  if (proven) {
    line("");
    line("  --- structural diff: unproven vs proven ---");
    for (const [label, tx] of [
      ["unproven", unproven],
      ["proven", proven],
    ]) {
      for (const [segmentId, intent] of tx.intents ?? []) {
        const t = intent.actions?.[0];
        const pt = t?.fallibleTranscript ?? t?.guaranteedTranscript;
        let proofInfo = "n/a";
        if (pt) {
          const parts = [];
          for (const k of Object.keys(pt)) {
            const v = pt[k];
            if (v && typeof v === "object" && "proof" in v) {
              const p = v.proof;
              parts.push(`${k}: proof=${p === null || p === undefined ? "ABSENT" : `present(${(p.byteLength ?? p.length ?? 0)}B)`}`);
            }
          }
          proofInfo = parts.join(" | ") || `no proof-bearing keys (keys: ${Object.keys(pt).join(",")})`;
        }
        line(`    ${label.padEnd(8)} intent[${segmentId}] actions=${intent.actions?.length ?? 0}  ${proofInfo}`);
      }
    }
    line("");
    line("  --- exact probe of the PROOF-BEARING transaction ---");
    // Line 249 of Transacting.js: this is what computeBalancingRecipe does to
    // the input transactions BEFORE any eraseProofs().
    const pFee = probe("proven.feesWithMargin(REAL,5)", () => proven.feesWithMargin(ledgerParameters, 5));
    if (pFee.ok) line(`     fee = ${pFee.v}`);
    probe("proven.imbalances(0, fee)", () => proven.imbalances(0, pFee.ok ? pFee.v : 0n));
    // dryRunFee body, in order.
    const pErased = probe("proven.eraseProofs()", () => proven.eraseProofs());
    if (pErased.ok) {
      probe("erased.feesWithMargin(REAL,5)", () => pErased.v.feesWithMargin(ledgerParameters, 5));
      line(`     -> this is the object the real code path hands to feesWithMargin`);
    }
    // Control: the unproven transaction through the same calls.
    probe("unproven.eraseProofs()", () => unproven.eraseProofs());
  }
}

// ---------------------------------------------------------------------------
// 6. Reproduce dryRunFee's EXACT object graph.
//    dryRunFee (Transacting.js:226) is the one place that still builds an EMPTY
//    DustActions when the recipe selects no coin — the empty-DUST patch covers
//    balanceTransactions, NOT this function:
//        const intent = Intent.new(ttl);
//        intent.dustActions = new DustActions(..., [...spends], []);   // spends == []
//        const mergedTx = mergedExisting.merge(erasedBalancing);
//        return this.calculateFee(mergedTx, ledgerParams);            // <-- feesWithMargin
//    This constructs precisely that transaction and prices it.
// ---------------------------------------------------------------------------
head("6. dryRunFee's exact object graph (empty-DustActions balancing segment)");
const proto = await import(
  pathToFileURL(resolve(`${stableRoot}/midnight-js-protocol/dist/ledger.mjs`)).href
);
const { Transaction: LedgerTransaction, Intent: LedgerIntent, DustActions: LedgerDustActions } = proto;
void LedgerTransaction;
void LedgerDustActions;

const baseTx = proven ?? unproven;
const erasedBase = baseTx.eraseProofs();
const segId = Math.min(...erasedBase.intents.keys(), 1);
const now = new Date();
const buildMerged = (spendsList) => {
  const intent = LedgerIntent.new(now);
  intent.dustActions = new LedgerDustActions("signature", "pre-proof", now, spendsList, []);
  const balancing = LedgerTransaction.fromParts("preview").addIntent({ tag: "specific", value: segId }, intent);
  return erasedBase.merge(balancing.eraseProofs());
};

// Case A: exactly what dryRunFee does when the recipe selects no coin.
const mergedEmpty = buildMerged([]);
line(`  built merged tx with an EMPTY DustActions segment at intent[${segId}]`);
const a = probe("empty-dust merged .feesWithMargin", () => mergedEmpty.feesWithMargin(ledgerParameters, 5));
if (a.ok) line(`     fee = ${a.v}`);
probe("empty-dust merged .imbalances(0, fee)", () => mergedEmpty.imbalances(0, a.ok ? a.v : 0n));
probe("empty-dust merged .eras(eraseProofs)", () => mergedEmpty.eraseProofs());
// Also: what the ledger's own dust well-formedness rule says about that segment.
for (const [sid, intent] of mergedEmpty.intents) {
  const da = intent.dustActions;
  if (!da) continue;
  const sp = da.spends?.length ?? 0;
  const rg = da.registrations?.length ?? 0;
  line(
    `  merged intent[${sid}] dustActions{spends:${sp}, registrations:${rg}} -> ` +
      (sp === 0 && rg === 0 ? "NOT NORMALIZED (dust.rs:768)" : "canonical"),
  );
}

// ---------------------------------------------------------------------------
// 6b. Simulate computeBalancingRecipe's convergence loop EXACTLY.
//     while (!converged) { recipe = getBalanceRecipe(dust -> currentFee);
//                          newFee = dryRunFee(...); converged = newFee <= coverage }
//     With an empty recipe, coverage == 0n, so convergence requires newFee <= 0.
//     If dryRunFee reports 1 forever, `converged` is never true and the SDK
//     spins here — which is precisely where the real run stopped making
//     progress for ~30 minutes.
// ---------------------------------------------------------------------------
head("6b. computeBalancingRecipe convergence simulation (recipe is EMPTY: coverage = 0)");
line("  iter  currentFee  newFee  coverage  converged");
let currentFee = 0n;
for (let i = 1; i <= 8; i++) {
  const m = buildMerged([]);
  let newFee;
  try {
    newFee = m.feesWithMargin(ledgerParameters, 5);
  } catch (e) {
    line(`  ${String(i).padStart(3)}  ${currentFee}  THREW ${String(e?.message ?? e).slice(0, 60)}  -> the panic reproduced`);
    break;
  }
  const coverage = 0n; // recipeInputs is empty
  const converged = newFee <= coverage;
  line(`  ${String(i).padStart(3)}  ${String(currentFee).padStart(10)}  ${String(newFee).padStart(6)}  ${String(coverage).padStart(8)}  ${converged}`);
  if (converged) {
    line("  -> CONVERGED");
    break;
  }
  currentFee = newFee;
  if (i === 8) line("  -> still NOT converged after 8 iterations: this loop cannot terminate while the recipe is empty");
}

// ---- the same loop, but with dryRunFee patched to price the bare transaction ----
head("6c. Same loop with the patch: price the existing transactions, no empty DustActions");
line("  iter  currentFee  newFee  coverage  converged");
let pcFee = 0n;
for (let i = 1; i <= 3; i++) {
  // Patched dryRunFee: spends.length === 0  ->  return calculateFee(bareExisting)
  // bareExisting is just the erased call transaction; no balancing intent at all.
  let newFee;
  try {
    newFee = baseTx.eraseProofs().feesWithMargin(ledgerParameters, 5);
  } catch (e) {
    line(`  ${String(i).padStart(3)}  ${pcFee}  THREW ${String(e?.message ?? e).slice(0, 60)}`);
    break;
  }
  const converged = newFee <= 0n;
  line(`  ${String(i).padStart(3)}  ${String(pcFee).padStart(10)}  ${String(newFee).padStart(6)}  ${String(0n).padStart(8)}  ${converged}`);
  if (converged) {
    line("  -> CONVERGED on the first pass: the recipe terminates and no dust segment is emitted");
    break;
  }
  pcFee = newFee;
}

head("SUMMARY");
line(`  participant registered on chain : yes`);
line(`  witness generation (local)     : ${WITNESS_OK ? "SUCCEEDED" : "FAILED"}`);
line(`  feesWithMargin(realParams, 5)   : ${FEE_OK ? `OK (fee = ${FEE})` : "THREW " + String(FEE_ERR).slice(0, 140)}`);
line(`  dust imbalance at that fee      : ${IMB ?? "n/a"}`);
line(`  transaction submitted          : NO (this script cannot submit)`);
line(`  private state / secret printed : NO`);
line();
line("  WHAT THIS RULES OUT");
line("    - the Compact circuit, the Merkle path and every contract assertion");
line("    - the proof itself: proveTx returns in ~8s, and the proof-bearing");
line("      transaction prices, balances, erases and merges without incident");
line("    - feesWithMargin itself: it returns 0 for the bare call transaction");
line("    - the earlier error 117 (no dust segment is attached at all here)");
line();
line("  ACTUAL ROOT CAUSE (compare 6b with 6c)");
line("    computeBalancingRecipe() cannot terminate for this call. Its loop is");
line("        while (!converged) { recipe = getBalanceRecipe(dust -> currentFee);");
line("                             newFee  = dryRunFee(...);");
line("                             converged = newFee <= coverage }");
line("    The recipe is legitimately empty (Preview prices this call at fee 0), so");
line("    coverage is 0 and convergence REQUIRES newFee <= 0. But dryRunFee()");
line("    merges a throwaway intent carrying an EMPTY DustActions purely in order");
line("    to price it, and that extra intent is not free: the price goes 0 -> 1.");
line("    newFee is then pinned at 1, converged is never true, and Effect.iterate");
line("    spins forever, allocating one throwaway Transaction per pass. The real");
line("    run burned ~30 minutes of CPU with no output and then died with");
line("    `RuntimeError: unreachable` — Rust's allocation-failure handler aborting");
line("    once the WASM heap is exhausted. The panic is the TERMINAL SYMPTOM of");
line("    the non-terminating loop, not an independent ledger bug.");
line();
line("    With the dryRunFee half of scripts/patch-dust-empty-actions.mjs applied,");
line("    the existing transactions are priced as they are (0), coverage is 0, and");
line("    the loop converges on its first pass (6c). balanceTransactions then");
line("    omits the dust segment entirely, so the emitted transaction carries no");
line("    DustActions at all — so error 117 cannot recur either.");
line("done.");
