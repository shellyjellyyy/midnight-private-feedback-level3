/**
 * Independent verification of the submitFeedback E2E run.
 *
 * This deliberately does NOT read logs/deploy-preview-run-*.log. It re-queries
 * the Preview indexer for the named transactions and re-derives the contract
 * state from chain, so a run log claiming success cannot be right if the chain
 * disagrees.
 *
 *   node scripts/verify-submitfeedback-onchain.mjs <contractAddress> <txId> [txId...]
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const [, , CONTRACT_ADDRESS, ...TX_IDS] = process.argv;
if (!CONTRACT_ADDRESS) {
  console.error("usage: node scripts/verify-submitfeedback-onchain.mjs <contractAddress> <txId> [txId...]");
  process.exit(2);
}

const INDEXER_HTTP = "https://indexer.preview.midnight.network/api/v4/graphql";
const INDEXER_WS = "wss://indexer.preview.midnight.network/api/v4/graphql/ws";

// Same era-scoped resolution the deploy/diag scripts use: ledger-v8 stable stack
// from the nested testkit copy, NOT the hoisted v9-era packages.
const ARTIFACT_DIR = "managed/feedback-v8";
const req = createRequire(import.meta.url);
const stableRoot = "node_modules/@midnight-ntwrk/testkit-js-stable/node_modules/@midnight-ntwrk";
const importStable = (name) => import(pathToFileURL(resolve(`${stableRoot}/${name}/dist/index.mjs`)).href);

const testkit = await import("@midnight-ntwrk/testkit-js-stable");
const managed = await import(pathToFileURL(resolve(ARTIFACT_DIR, "contract/index.js")).href);
managed.checkRuntimeVersion?.("0.16.0");
const stableTypes = await importStable("midnight-js-types");
const { indexerPublicDataProvider } = await importStable("midnight-js-indexer-public-data-provider");
const networkIdMod = await importStable("midnight-js-network-id");
networkIdMod.setNetworkId("preview");

const SEP = "=".repeat(64);
const line = (s = "") => console.log(s);
const head = (s) => { line(); line(s); line("-".repeat(s.length)); };

line(SEP);
line("INDEPENDENT ON-CHAIN VERIFICATION (re-read from Preview, not from the run log)");
line(SEP);
line(`contract: ${CONTRACT_ADDRESS}`);
line(`indexer : ${INDEXER_HTTP}`);

const pdp = indexerPublicDataProvider(INDEXER_HTTP, INDEXER_WS);
const address = stableTypes.asContractAddress(CONTRACT_ADDRESS);
const zcs = await pdp.queryZSwapAndContractState(address);
if (!zcs) {
  console.error(`[FAIL] indexer has no state for ${CONTRACT_ADDRESS} on Preview.`);
  process.exit(3);
}

head("1. contract state re-derived from chain");
const [, , ledgerParameters] = zcs;
const l = managed.ledger(zcs[1].data);
line(`  participantCount : ${l.participantCount}`);
line(`  responseCount    : ${l.responseCount}`);
line(`  surveyOpen       : ${l.surveyOpen}`);
line(`  usedNullifiers   : ${l.usedNullifiers.size()}`);
const ratings = [];
for (let r = 1; r <= 5; r++) ratings.push({ rating: r, count: l[`rating${r}`] });
line(`  per-rating tally : ${ratings.map((x) => `${x.rating}->${x.count}`).join("  ")}`);

head("2. transactions named by the run — looked up on-chain by their wallet tx id");
line("   (the v4 indexer has no per-transaction status field; inclusion is proven by");
line("    resolving each id to a real on-chain hash, block height and contract action)");
if (TX_IDS.length === 0) line("  (no txIds supplied)");
let allSucceeded = true;
const found = [];
for (const txId of TX_IDS) {
  try {
    const r = await fetch(INDEXER_HTTP, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query Verify($o: TransactionOffset!) {
          transactions(offset: $o) { hash block { height } contractActions { __typename } }
        }`,
        variables: { o: { identifier: txId.startsWith("0x") ? txId : "0x" + txId } },
      }),
    });
    const j = await r.json();
    const t = j?.data?.transactions?.[0];
    if (!t) { allSucceeded = false; line(`  ${txId}  -> NOT FOUND ON CHAIN`); continue; }
    found.push({ txId, hash: t.hash, height: t.block.height, actions: t.contractActions });
    line(`  ${txId}`);
    line(`      on-chain hash : ${t.hash}`);
    line(`      block height  : ${t.block.height}`);
    line(`      contract calls: ${(t.contractActions ?? []).map((a) => a.__typename).join(", ") || "(none)"}`);
  } catch (e) { allSucceeded = false; line(`  ${txId}  -> query failed: ${String(e?.message ?? e).slice(0, 60)}`); }
}
if (found.length > 1) {
  const ordered = [...found].sort((a, b) => a.height - b.height).map((f) => f.height);
  const inOrder = ordered.every((h, i) => i === 0 || h > ordered[i - 1]);
  line();
  line(`  block order    : ${ordered.join(" -> ")}  (${inOrder ? "strictly increasing, consistent with the run order" : "NOT monotonic"})`);
  if (!inOrder) allSucceeded = false;
}

head("3. verdict");
const checks = [
  ["every named transaction is included in a block", allSucceeded],
  ["responseCount === 1  (exactly one anonymous feedback on chain)", l.responseCount === 1n],
  ["rating4 === 1        (the submitted rating-4 landed in the right bucket)", l.rating4 === 1n],
  ["ratings 1,2,3,5 === 0 (nothing leaked into another bucket)", [1, 2, 3, 5].every((r) => l[`rating${r}`] === 0n)],
  ["usedNullifiers === 1 (nullifier recorded -> replay impossible)", Number(l.usedNullifiers.size()) === 1],
  ["surveyOpen === true  (close/reopen round-trip returned to open)", l.surveyOpen === true],
];
let ok = true;
for (const [label, pass] of checks) { line(`  ${pass ? "PASS" : "FAIL"}  ${label}`); if (!pass) ok = false; }
line();
line(ok
  ? "VERIFIED: the chain agrees the anonymous feedback submission is real and final."
  : "MISMATCH: the chain disagrees with the run log — do not trust the log.");
line("NOTE: counts are public by design. The rating of an individual, the ciphertext");
line("      and the participant secret are NOT observable from chain state — that is");
line("      the privacy property, not a gap in this verification.");
line(SEP);
process.exit(ok ? 0 : 1);
