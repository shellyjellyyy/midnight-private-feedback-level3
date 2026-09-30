#!/usr/bin/env node
/**
 * READ-ONLY diagnosis of ledger error 117 (NotNormalized) for Preview contract
 * call transactions.
 *
 *   node --max-old-space-size=8192 scripts/diag-notnormalized.mjs [path-to-hex-file ...]
 *
 * WHAT IT DOES
 *   1. Reads the REAL ledger parameters currently in effect on Preview from the
 *      public indexer (`block(offset: null) { ledgerParameters }`) — the exact
 *      bytes the wallet's dust sync deserializes into `blockData.ledgerParameters`.
 *   2. Reads the REAL on-chain state of the deployed Feedback contract through
 *      the indexer (participantCount / responseCount / surveyOpen / nullifiers /
 *      rating tally) plus the REAL Zswap chain state and ledger parameters via
 *      `queryZSwapAndContractState`.
 *   3. Deserializes any captured broadcast transaction hex files, and for each
 *      intent reports the DUST segment shape, the transcript ops, and the fee /
 *      imbalance the wallet's own balancing arithmetic would have computed.
 *   4. Applies the ledger's own rule from midnight-ledger 8.1.2 `src/dust.rs:768`
 *      and reports exactly which (if any) intents are non-canonical.
 *
 * WHAT IT NEVER DOES
 *   - It never builds, signs, proves or SUBMITS a transaction.
 *   - It never touches a wallet, a seed or a secret. No key material is read.
 *   - It cannot move funds: it holds no signing capability at all.
 *
 * WHY IT IS NEEDED (root cause, fully reproduced 2026-09-29)
 *   Contract DEPLOY succeeded; every contract CALL was rejected by the mempool
 *   with `1010: Invalid Transaction: Custom error: 117`.
 *
 *   midnight-ledger 8.1.2  src/dust.rs:768
 *       if self.spends.is_empty() && self.registrations.is_empty() {
 *           warn!("non-canonical dust actions: empty");
 *           return Err(MalformedTransaction::NotNormalized);
 *       }
 *
 *   @midnight-ntwrk/wallet-sdk-dust-wallet  dist/v1/Transacting.js
 *   `balanceTransactions()` attaches the fee-balancing intent UNCONDITIONALLY,
 *   even when the balancing recipe selected no DUST coin, so the segment ends up
 *   with neither spends nor registrations.
 *
 *   On Preview the real cost model prices a small contract call at fee 0, so the
 *   recipe legitimately selects NO coin — and the empty segment is pure waste
 *   that the ledger rejects. This script prints both numbers so the chain is
 *   verifiable rather than assumed.
 *
 *   The upstream defect is still present in the newest published release
 *   (5.0.0-rc.0), so the repair is the local, reversible patch in
 *   scripts/patch-dust-empty-actions.mjs — not a dependency upgrade.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const INDEXER_HTTP = process.env.MIDNIGHT_INDEXER_HTTP ?? "https://indexer.preview.midnight.network/api/v4/graphql";
const CONTRACT_ADDRESS = (
  process.env.MIDNIGHT_PREVIEW_CONTRACT ??
  process.argv.find((a) => a.startsWith("--contract="))?.slice("--contract=".length) ??
  ""
).replace(/^0x/, "").toLowerCase();

const STABLE_ROOT = "node_modules/@midnight-ntwrk/testkit-js-stable/node_modules/@midnight-ntwrk";
// Retained v8 artifact — the contract whose transactions are being analysed.
const ARTIFACT_DIR = process.env.MIDNIGHT_PREVIEW_ARTIFACT ?? "managed/feedback-v8";
if (!existsSync(resolve(ARTIFACT_DIR, "contract/index.js"))) {
  console.error(`[BLOCKER] retained v8 artifact not found at ${ARTIFACT_DIR}/contract/index.js`);
  process.exit(2);
}
// IMPORT ORDER IS LOAD-BEARING. The Midnight WASM bindings assert concrete
// class identity ("expected instance of ChargedState"), so the v8 onchain
// runtime, the v8 ledger bindings and the retained artifact must all be bound
// to the SAME module instances. scripts/deploy-preview.mjs establishes that by
// importing the stable testkit first and the artifact last; this script mirrors
// that order exactly. Reordering these three imports breaks class identity.
const testkit = await import("@midnight-ntwrk/testkit-js-stable");
const managed = await import(pathToFileURL(resolve(ARTIFACT_DIR, "contract/index.js")).href);
managed.checkRuntimeVersion?.("0.16.0");
const stableProtocol = await import(
  pathToFileURL(resolve(`${STABLE_ROOT}/midnight-js-protocol/dist/ledger.mjs`)).href
);
const { Transaction, LedgerParameters: StableLedgerParameters } = stableProtocol;
const stableTypes = await import(
  pathToFileURL(resolve(`${STABLE_ROOT}/midnight-js-types/dist/index.mjs`)).href
);

const line = (s = "") => console.log(s);
const head = (s) => {
  line();
  line(`== ${s} ==`);
};

async function gql(query, variables) {
  const r = await fetch(INDEXER_HTTP, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(45000),
  });
  const j = await r.json();
  if (j.errors) throw new Error(`indexer GraphQL error: ${JSON.stringify(j.errors).slice(0, 400)}`);
  return j.data;
}

// A read-only PublicDataProvider. Needs no wallet, no seed and no key material,
// and can only ever READ — it has no submit path.
let providerPromise;
function makePublicDataProvider() {
  providerPromise ??= (async () => {
    const { indexerPublicDataProvider } = await import(
      pathToFileURL(resolve(`${STABLE_ROOT}/midnight-js-indexer-public-data-provider/dist/index.mjs`)).href
    );
    const wsUrl = INDEXER_HTTP.replace(/^http/, "ws");
    let webSocketImpl;
    try {
      ({ WebSocket: webSocketImpl } = await import("ws"));
    } catch {
      // Node >= 22 ships a global WebSocket; subscriptions are not used here.
    }
    return indexerPublicDataProvider(INDEXER_HTTP, wsUrl, webSocketImpl);
  })();
  return providerPromise;
}

// ---------------------------------------------------------------------------
// 1. Real ledger parameters in effect on Preview right now.
// ---------------------------------------------------------------------------
head("1. REAL ledger parameters from the Preview indexer");
const blockData = (await gql(`{ block(offset: null) { hash height timestamp ledgerParameters } }`)).block;
const realParams = (await import(pathToFileURL(resolve("node_modules/@midnight-ntwrk/ledger-v8/midnight_ledger_wasm_fs.js")).href)).LedgerParameters.deserialize(
  Buffer.from(blockData.ledgerParameters, "hex"),
);
line(`  chain tip height : ${blockData.height}`);
line(`  block hash       : ${blockData.hash}`);
line(`  ledgerParameters : deserialized OK from the indexer (${blockData.ledgerParameters.length / 2} bytes)`);
line(`  dust parameters  : ${String(realParams.dust).replace(/\s+/g, " ")}`);

// ---------------------------------------------------------------------------
// 2. Real on-chain state of the deployed Feedback contract.
// ---------------------------------------------------------------------------
if (CONTRACT_ADDRESS && /^[0-9a-f]{64}$/.test(CONTRACT_ADDRESS)) {
  head("2. REAL on-chain contract state (indexer)");
  // `offset: null` = latest block, so `state` is the CURRENT state, not the
  // deployment-time snapshot. Same bytes the publicDataProvider reads.
  const q = `query($a: HexEncoded!) {
      contract(address: $a, offset: null) { address state }
    }`;
  const d = await gql(q, { a: CONTRACT_ADDRESS });
  const c = d.contract;
  if (!c) {
    line(`  contract ${CONTRACT_ADDRESS}: NOT FOUND on Preview — nothing to analyse`);
  } else {
    line(`  contract address : ${c.address}`);
    line(`  verified on-chain: yes (indexer has a contract row at the chain tip)`);
    const stateHex = c.state;
    if (!stateHex) {
      line("  contract state   : no state row returned");
    } else {
      // Read the state through the SAME public data provider the deploy script
      // uses. This is what keeps the WASM class identities consistent: the
      // provider's ContractState and the retained artifact's ChargedState come
      // from one module graph, so `managed.ledger(...)` accepts it. Decoding by
      // hand against a differently-resolved ledger module fails with
      // "expected instance of ChargedState".
      const publicDataProvider = await makePublicDataProvider();
      const st = await publicDataProvider.queryContractState(stableTypes.asContractAddress(CONTRACT_ADDRESS));
      if (!st) {
        line("  contract state   : provider returned null");
      } else {
        const l = managed.ledger(st.data);
        line(`  surveyOpen        : ${l.surveyOpen}`);
        line(`  participantCount  : ${l.participantCount}`);
        line(`  responseCount     : ${l.responseCount}`);
        line(`  rating tally      : 1=${l.rating1} 2=${l.rating2} 3=${l.rating3} 4=${l.rating4} 5=${l.rating5}`);
        line(`  usedNullifiers    : ${l.usedNullifiers.size()}`);
        line(`  adminAddress      : ${Buffer.from(l.adminAddress).toString("hex")}`);
        line("  NOTE: the RATING TALLY IS PUBLIC by design. No secret is read by this script.");
      }
    }
  }
} else {
  head("2. REAL on-chain contract state (indexer)");
  line("  skipped — pass --contract=<32-byte-hex> to include this section");
}

// ---------------------------------------------------------------------------
// 3. Offline analysis of captured broadcast transactions.
// ---------------------------------------------------------------------------
head("3. Captured broadcast transactions vs. the ledger's normalization rule");

const DUST_WALLET_TRANSACTING = "node_modules/@midnight-ntwrk/wallet-sdk-dust-wallet/dist/v1/Transacting.js";
const patched = existsSync(DUST_WALLET_TRANSACTING)
  ? readFileSync(DUST_WALLET_TRANSACTING, "utf8").includes("patch-dust-empty-actions.mjs")
  : false;
line(`  dust-wallet patch applied: ${patched ? "YES" : "NO  (run: node scripts/patch-dust-empty-actions.mjs)"}`);

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const files = args.length
  ? args
  : existsSync("logs/tx-capture")
    ? readdirSync("logs/tx-capture")
        .filter((f) => f.endsWith(".hex"))
        .map((f) => `logs/tx-capture/${f}`)
    : [];

function describeTx(file) {
  line();
  line(`  --- ${file} ---`);
  const bytes = Buffer.from(readFileSync(file, "utf8").trim().replace(/^0x/, ""), "hex");
  let tx;
  let stage;
  try {
    tx = Transaction.deserialize("signature", "proof", "binding", bytes);
    stage = "binding";
  } catch {
    tx = Transaction.deserialize("signature", "proof", "pre-binding", bytes);
    stage = "pre-binding";
  }
  line(`  bytes=${bytes.length} stage=${stage}`);

  // The wallet's own fee arithmetic: Transacting.js calculateFee() uses
  // feesWithMargin(realParams, feeBlocksMargin) + additionalFeeOverhead(0).
  const fee = tx.feesWithMargin(realParams, 5);
  const feeInitialParams = tx.feesWithMargin(StableLedgerParameters.initialParameters(), 5);
  const imbalances = {};
  for (const [tt, v] of tx.imbalances(0, fee).entries()) imbalances[`${tt.tag}`] = v.toString();
  line(`  fee(realParams, margin 5)     = ${fee}`);
  line(`  fee(initialParameters, m 5)   = ${feeInitialParams}   (NOT what the wallet uses)`);
  line(`  imbalances(0, fee)            = ${JSON.stringify(imbalances)}`);
  line(`  -> wallet feeImbalance()      = ${imbalances.dust ?? "0n"}  (this is what drives coin selection)`);

  let nonCanonical = 0;
  for (const [segmentId, intent] of tx.intents) {
    const da = intent.dustActions;
    const actions = intent.actions?.length ?? 0;
    if (da == null) {
      line(`  intent[${segmentId}] actions=${actions} dustActions=absent  (OK: no dust segment)`);
      continue;
    }
    const spends = da.spends?.length ?? 0;
    const regs = da.registrations?.length ?? 0;
    // midnight-ledger 8.1.2 src/dust.rs:768
    const bad = spends === 0 && regs === 0;
    if (bad) nonCanonical++;
    line(
      `  intent[${segmentId}] actions=${actions} dustActions{spends:${spends}, registrations:${regs}} ` +
        `ctime=${new Date(da.ctime).toISOString()} -> ${bad ? "NOT NORMALIZED (ledger error 117)" : "canonical"}`,
    );
  }
  line(`  verdict: ${nonCanonical === 0 ? "no NotNormalized dust trigger" : `${nonCanonical} intent(s) would be rejected by dust.rs:768`}`);

  // Transcript ops: the OTHER historical NotNormalized source (verify.rs:1824,
  // two consecutive Op::Noop). Reported for completeness so it can be ruled out.
  const ops = [];
  for (const [segmentId, intent] of tx.intents) {
    for (const a of intent.actions ?? []) {
      const t = a.fallibleTranscript ?? a.guaranteedTranscript;
      if (!t?.program) continue;
      t.program.forEach((op, i) => ops.push({ where: `intent[${segmentId}].program[${i}]`, op: String(op) }));
    }
  }
  if (ops.length) {
    const noopRuns = ops.filter((o) => /noop/i.test(o.op));
    let consecutive = 0;
    for (let i = 1; i < ops.length; i++) {
      if (/noop/i.test(ops[i].op) && /noop/i.test(ops[i - 1].op)) consecutive++;
    }
    line(`  transcript ops=${ops.length} noop=${noopRuns.length} consecutive-noop-pairs=${consecutive}` + (consecutive ? "  (verify.rs:1824 trigger)" : "  (no verify.rs:1824 trigger)"));
  }
  return nonCanonical;
}

let totalBad = 0;
let analysed = 0;
for (const f of files) {
  try {
    totalBad += describeTx(f);
    analysed++;
  } catch (e) {
    line(`  --- ${f} --- SKIPPED: ${(e?.message ?? String(e)).slice(0, 160)}`);
  }
}
if (analysed === 0) line("  (no captured transactions found — pass one or more .hex files)");

line();
head("SUMMARY");
line(`  ledger error 117 = NotNormalized = ${!patched ? "a DustActions segment with 0 spends AND 0 registrations" : "NOT reachable via the dust path while the patch is applied"}`);
line(`  non-canonical dust intents found in captured transactions: ${totalBad}`);
line(`  transaction submission attempted: NO (this script cannot submit)`);
line("done.");
void createRequire;
void testkit;
void stableTypes;
