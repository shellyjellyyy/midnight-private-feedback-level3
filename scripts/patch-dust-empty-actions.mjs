#!/usr/bin/env node
/**
 * Patch: the DUST fee-balancing segment must never be emitted EMPTY.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT (empirically reproduced on Midnight Preview, 2026-09-29)
 * ---------------------------------------------------------------------------
 * `@midnight-ntwrk/wallet-sdk-dust-wallet`'s `balanceTransactions()` builds the
 * fee-balancing intent and then attaches it to a transaction UNCONDITIONALLY:
 *
 *   const [spends, updatedState] = CoreWallet.spendCoins(state, secretKey, recipeInputs, currentTime);
 *   intent.dustActions = new DustActions(SignatureMarker.signature, ProofMarker.preProof,
 *                                        currentTime, [...spends], []);   // <-- [] registrations
 *   ...
 *   const feeTransaction = Transaction.fromParts(networkId)
 *       .addIntent({ tag: 'specific', value: segmentId }, intent);
 *   return [feeTransaction, updatedState];
 *
 * When the balancing recipe selects no DUST coin, `spends` is `[]`, so the
 * attached `DustActions` has NEITHER spends NOR registrations. The ledger
 * rejects exactly that shape as non-canonical:
 *
 *   midnight-ledger 8.1.2  src/dust.rs:768
 *     if self.spends.is_empty() && self.registrations.is_empty() {
 *         warn!("non-canonical dust actions: empty");
 *         return Err(MalformedTransaction::NotNormalized);   // -> node error 117
 *     }
 *
 * Symptom observed live: the contract DEPLOY succeeds (its balancing recipe
 * spends 1 DUST coin), and every subsequent CONTRACT CALL is rejected by the
 * mempool within ~1s with
 *     1010: Invalid Transaction: Custom error: 117
 * (i.e. a transaction-pool normalization failure, NOT a Compact
 * circuit/witness/proof failure). Proof of the malformed object, from the real
 * broadcast bytes of the rejected registration (deserialized with the stable
 * v8 ledger module):
 *     intents: { "1":     { actions: [], dustActions: { spends: [], registrations: [] } },
 *                "57157": { actions: [ <contract call> ] } }
 *
 * ---------------------------------------------------------------------------
 * WHY A LOCAL PATCH (no dependency upgrade can fix this)
 * ---------------------------------------------------------------------------
 * The defect is still present in the newest published release. Verified
 * 2026-09-29 by unpacking `@midnight-ntwrk/wallet-sdk-dust-wallet@5.0.0-rc.0`
 * and diffing `dist/v1/Transacting.js` (and `dist/v2/Transacting.js`): the
 * `balanceTransactions` body above is byte-identical to 4.1.0 apart from the
 * import scope rename. `4.1.0` is also the current `latest` on npm. There is
 * no fixed version to upgrade to.
 *
 * ---------------------------------------------------------------------------
 * THE FIX
 * ---------------------------------------------------------------------------
 * Skip attaching the fee-balancing intent when it would carry an empty
 * `DustActions`, i.e. when the ledger's own `dust.rs:768` predicate holds:
 *
 *     spends.length === 0 && dustActions.registrations.length === 0
 *
 * This is a no-op in the normal case (a transaction that owes a DUST fee
 * always selects a coin, so the segment stays). It is strictly safer than the
 * status quo: an omitted segment can only leave the transaction fee-unpaid,
 * which the ledger rejects with an explicit balance error at execution time —
 * it can never make a malformed transaction acceptable.
 *
 * `mergeUnprovenTransactions(a, b)` in the wallet facade is `a ?? b` when
 * either side is falsy, so returning `undefined` for the balancing transaction
 * is an already-supported shape (the facade itself passes `undefined` whenever
 * `payFees` is false).
 *
 * ---------------------------------------------------------------------------
 * PROPERTIES
 * ---------------------------------------------------------------------------
 * - Reproducible:  node scripts/patch-dust-empty-actions.mjs
 * - Idempotent:    re-running is a no-op (detected by sentinel).
 * - Verified:      refuses to run against an unexpected package version, and
 *                  aborts if the anchor text is not found (upstream moved).
 * - Reversible:    node scripts/patch-dust-empty-actions.mjs --revert
 *
 * SCOPE: only the two top-level copies that the stable (Preview / retained
 * ledger-v8) wallet path can resolve. The nested beta.3 copy under
 * testkit-js belongs to the v9 era and is deliberately LEFT UNTOUCHED so the
 * era separation and the nested resolution graph stay intact — run
 * `node scripts/check-resolution-graph.mjs` to confirm that still holds.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const REVERT = process.argv.includes("--revert");

const SENTINEL = "// PATCHED (scripts/patch-dust-empty-actions.mjs): never emit an empty DustActions (ledger dust.rs:768 NotNormalized)";
const SENTINEL_LOOP = "// PATCHED (scripts/patch-dust-empty-actions.mjs): price WITHOUT the empty DustActions, else the recipe never converges";

// ---------------------------------------------------------------------------
// ANCHOR 1 — balanceTransactions(). Attaches the fee-balancing intent
// unconditionally, producing a DustActions with 0 spends AND 0 registrations,
// which midnight-ledger 8.1.2 src/dust.rs:768 rejects as NotNormalized
// (node error 117). The contract DEPLOY worked because its recipe really did
// select one DUST coin; every CONTRACT CALL was rejected because its recipe
// correctly selects none.
// ---------------------------------------------------------------------------
const ANCHOR =
  "                const [spends, updatedState] = CoreWallet.spendCoins(state, secretKey, recipeInputs, currentTime);\n" +
  "                intent.dustActions = new DustActions(SignatureMarker.signature, ProofMarker.preProof, currentTime, [...spends], []);\n" +
  "                // Merge existing transactions first so we can pick a segment that doesn't collide\n";

const REPLACEMENT =
  "                const [spends, updatedState] = CoreWallet.spendCoins(state, secretKey, recipeInputs, currentTime);\n" +
  "                intent.dustActions = new DustActions(SignatureMarker.signature, ProofMarker.preProof, currentTime, [...spends], []);\n" +
  `                ${SENTINEL}\n` +
  "                if (spends.length === 0 && intent.dustActions.registrations.length === 0) {\n" +
  "                    return [undefined, updatedState];\n" +
  "                }\n" +
  "                // Merge existing transactions first so we can pick a segment that doesn't collide\n";

// ---------------------------------------------------------------------------
// ANCHOR 2 — dryRunFee(). Same empty DustActions, but here it is WORSE: the
// empty balancing intent is merged into a throwaway transaction purely to be
// priced by `calculateFee`. That intent is not free — it adds a second intent's
// baseline/binding cost to the transaction, so the price of a contract call that
// genuinely owes NO DUST fee goes from 0 to 1.
//
// computeBalancingRecipe() then cannot terminate:
//     while (!converged) { recipe = getBalanceRecipe(dust -> currentFee);
//                          newFee  = dryRunFee(...);
//                          converged = newFee <= coverage }   // coverage == 0
// With coverage == 0n, convergence needs newFee <= 0, but newFee is pinned at 1,
// so `converged` is never true and Effect.iterate spins forever. Measured on
// Preview 2026-09-30 for the real submitFeedback transaction:
//     iter 1..8   currentFee 0->1   newFee 1   coverage 0   converged false
// The SDK burns CPU indefinitely allocating one throwaway Transaction per pass
// until the WASM heap is exhausted, at which point Rust's allocation-failure
// handler aborts and wasm-bindgen surfaces it as `RuntimeError: unreachable`.
// That is the `Wallet.Other: unreachable` seen ~30 minutes into the real run
// with no output. It is the TERMINAL SYMPTOM of this non-terminating loop, not
// an independent ledger bug.
//
// Fix: when the recipe selects no coin, price the existing transactions as they
// are. feesWithMargin on the erased call transaction is 0, so coverage 0 gives
// newFee 0 <= 0 and the loop converges on its first pass — and
// balanceTransactions() (ANCHOR 1) then omits the dust segment entirely.
// ---------------------------------------------------------------------------
const ANCHOR2 = "        const [spends] = CoreWallet.spendCoins(state, secretKey, recipeInputs, currentTime);\n" + "        const intent = Intent.new(ttl);\n";

const REPLACEMENT2 =
  "        const [spends] = CoreWallet.spendCoins(state, secretKey, recipeInputs, currentTime);\n" +
  `        ${SENTINEL_LOOP}\n` +
  "        if (spends.length === 0) {\n" +
  "            const [bareFirst, ...bareRest] = transactions.map((tx) => tx.eraseProofs());\n" +
  "            const bareExisting = bareFirst ? bareRest.reduce((acc, tx) => acc.merge(tx), bareFirst) : Transaction.fromParts(network);\n" +
  "            return this.calculateFee(bareExisting, ledgerParams);\n" +
  "        }\n" +
  "        const intent = Intent.new(ttl);\n";

// Only versions whose `balanceTransactions` body matches ANCHOR are eligible.
// 4.1.0 = stable/Preview path (what deploy-preview.mjs loads).
// 4.2.0 = hoisted @midnightntwrk copy, same code, kept consistent.
// 5.0.0-beta.3 = v9 era -> intentionally excluded (era separation).
const TARGETS = [
  {
    dir: "node_modules/@midnight-ntwrk/wallet-sdk-dust-wallet",
    versions: ["4.1.0"],
    label: "stable/Preview wallet-sdk-dust-wallet (used by deploy-preview.mjs)",
  },
  {
    dir: "node_modules/@midnightntwrk/wallet-sdk-dust-wallet",
    versions: ["4.2.0"],
    label: "hoisted @midnightntwrk wallet-sdk-dust-wallet",
  },
];

const SKIPPED = [
  {
    dir: "node_modules/@midnight-ntwrk/testkit-js/node_modules/@midnightntwrk/wallet-sdk-dust-wallet",
    label: "v9-era nested beta.3 copy (era separation — intentionally not patched)",
  },
];

const sha256 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
let failed = false;

/** Apply or revert both anchors independently so a partially-applied file
 *  (possible if a previous run was interrupted) still converges. */
function transform(source, { revert }) {
  let out = source;
  const patches = [
    { name: "balanceTransactions", sentinel: SENTINEL, from: ANCHOR, to: REPLACEMENT },
    { name: "dryRunFee", sentinel: SENTINEL_LOOP, from: ANCHOR2, to: REPLACEMENT2 },
  ];
  for (const p of patches) {
    const isPatched = out.includes(p.sentinel);
    if (revert) {
      if (!isPatched) continue;
      if (!out.includes(p.to)) return { error: `patched '${p.name}' block not found verbatim` };
      out = out.replace(p.to, p.from);
      if (out.includes(p.sentinel)) return { error: `revert of '${p.name}' left the sentinel behind` };
    } else {
      if (isPatched) continue;
      if (!out.includes(p.from)) return { error: `ANCHOR for '${p.name}' not found — upstream changed` };
      out = out.replace(p.from, p.to);
      if (!out.includes(p.sentinel) || out.includes(p.from)) return { error: `verification of '${p.name}' failed` };
    }
  }
  return { out };
}

for (const t of TARGETS) {
  const pkgPath = `${t.dir}/package.json`;
  const file = `${t.dir}/dist/v1/Transacting.js`;
  if (!existsSync(pkgPath) || !existsSync(file)) {
    console.log(`skip (not installed): ${t.label}`);
    continue;
  }
  const version = JSON.parse(readFileSync(pkgPath, "utf8")).version;
  if (!t.versions.includes(version)) {
    console.error(`REFUSING: ${t.label} is version ${version}, expected ${t.versions.join("|")}.`);
    console.error("         Upstream layout may have changed — re-check the anchors before patching.");
    failed = true;
    continue;
  }

  const original = readFileSync(file, "utf8");
  const { out, error } = transform(original, { revert: REVERT });
  if (error) {
    console.error(`REFUSING: ${t.label} (${version}) — ${error}`);
    failed = true;
    continue;
  }
  if (out === original) {
    const state = REVERT ? "already clean" : "already patched";
    console.log(`${state}: ${t.label} (${version})`);
    continue;
  }
  writeFileSync(file, out);
  console.log(`${REVERT ? "reverted" : "patched"}: ${t.label} (${version})`);
  console.log(`  ${sha256(original)} -> ${sha256(out)}`);
  console.log(`  anchors now patched: balanceTransactions=${out.includes(SENTINEL)} dryRunFee=${out.includes(SENTINEL_LOOP)}`);
}

for (const s of SKIPPED) {
  if (existsSync(`${s.dir}/package.json`)) console.log(`skipped: ${s.label}`);
}

if (failed) process.exit(1);
console.log("done.");
