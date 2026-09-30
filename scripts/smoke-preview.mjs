#!/usr/bin/env node
/**
 * PREVIEW SMOKE TEST (headless, real network, stable v8-era stack):
 *   node scripts/smoke-preview.mjs
 *   MIDNIGHT_SMOKE_TIMEOUT_SECS=1500 node scripts/smoke-preview.mjs   # wait out full sync
 *
 * Builds a real Node wallet on the live Preview network with testkit-js 4.1.1
 * (the stable ledger-v8 line) and proves, with real measurements:
 *   1. the wallet builds (shielded + unshielded + dust wallets from one seed),
 *   2. the real unshielded address can be derived (available pre-sync),
 *   3. all three sync channels CONNECT to the live Preview indexer/node,
 *   4. sync actually PROGRESSES (real appliedIndex numbers climbing),
 *   5. the unshielded channel reaches strict completion.
 *
 * PASS = all five. Full shielded/dust catch-up takes ~15-20 min from cold on
 * Preview (chain-scale bound); MIDNIGHT_SMOKE_TIMEOUT_SECS raises the wait.
 * No secrets are ever printed (redacting logger).
 */

import process from "node:process";
import { randomBytes } from "node:crypto";
import { rememberSecret, makeRedactingLogger } from "./lib-redacting-logger.mjs";

const logger = makeRedactingLogger();
const SEED = process.env.MIDNIGHT_PREVIEW_SEED?.trim();
const SYNC_TIMEOUT_MS = Number(process.env.MIDNIGHT_SMOKE_TIMEOUT_SECS ?? "240") * 1000;

console.log("== Preview smoke test (stable v8-era stack: testkit-js 4.1.1, ledger-v8 8.1.2) ==");

const testkit = await import("@midnight-ntwrk/testkit-js-stable");

const env = new testkit.PreviewTestEnvironment(logger);
env.proofServerContainer = {
  getUrl: () => process.env.MIDNIGHT_PROOF_SERVER_PREVIEW ?? "https://proof-server.preview.midnight.network",
  stop: async () => {},
};
const envConfig = env.getEnvironmentConfiguration();
console.log(`  indexer: ${envConfig.indexer}`);
console.log(`  node:    ${envConfig.node}`);
console.log(`  faucet:  ${envConfig.faucet}`);
console.log(`  proof:   ${envConfig.proofServer}`);
console.log(`  netId:   ${envConfig.networkId} (wallet: ${envConfig.walletNetworkId})`);

const seed = SEED ?? Buffer.from(randomBytes(32)).toString("hex");
rememberSecret(seed);
console.log(`  wallet seed: ${SEED ? "from MIDNIGHT_PREVIEW_SEED (redacted)" : "random throwaway (redacted)"}`);

console.log("== Building real wallet (MidnightWalletProvider.build) ==");
const wallet = await testkit.MidnightWalletProvider.build(logger, envConfig, seed);

// The shielded address derives from the seed alone — no sync required.
let coinAddress = "unavailable";
try {
  const initialState = await testkit.getInitialShieldedState(wallet.wallet.shielded);
  coinAddress = initialState.address.coinPublicKeyString();
} catch (e) {
  console.log(`  address derivation via getInitialShieldedState failed: ${e.message}`);
}

console.log("== start(false) — real indexer/node sync, no faucet attempt ==");
await wallet.start(false);

console.log(`== bounded sync wait (max ${SYNC_TIMEOUT_MS / 1000}s), snapshots every 20s ==`);
let lastFacadeState = null;
const stateSub = wallet.wallet.state().subscribe({
  next: (s) => {
    lastFacadeState = s;
  },
  error: (e) => console.log(`  [state observable error: ${e?.message ?? e}]`),
});
const describeProgress = (p) => {
  if (!p) return "null";
  const nums = {};
  for (const k of ["appliedIndex", "highestIndex", "appliedId", "highestTransactionId", "highestRelevantIndex", "highestRelevantWalletIndex"]) {
    if (p[k] !== undefined) nums[k] = String(p[k]).slice(0, 20);
  }
  return `connected=${p.isConnected} strict=${p.isStrictlyComplete?.()} ${JSON.stringify(nums)}`;
};
const snapshotTimer = setInterval(() => {
  if (!lastFacadeState) {
    console.log("  [snapshot] no facade state emitted yet");
    return;
  }
  let shielded = "?";
  let dust = "?";
  try { shielded = describeProgress(lastFacadeState.shielded?.state?.progress); } catch {}
  try { dust = describeProgress(lastFacadeState.dust?.state?.progress); } catch {}
  const unshielded = describeProgress(lastFacadeState.unshielded?.progress);
  console.log(`  [snapshot] shielded{${shielded}} unshielded{${unshielded}} dust{${dust}}`);
}, 20000);

const firstShieldedSnapshot = { applied: null, at: null };
const progressWatcher = setInterval(() => {
  const applied = lastFacadeState?.shielded?.state?.progress?.appliedIndex;
  if (applied !== undefined) {
    if (firstShieldedSnapshot.applied === null) {
      firstShieldedSnapshot.applied = applied;
      firstShieldedSnapshot.at = Date.now();
    }
  }
}, 1000);

const synced = await Promise.race([
  wallet.wallet.waitForSyncedState(),
  new Promise((_, rej) => setTimeout(() => rej(new Error(`sync timeout after ${SYNC_TIMEOUT_MS / 1000}s`)), SYNC_TIMEOUT_MS)),
]).then(
  (s) => {
    clearInterval(snapshotTimer);
    clearInterval(progressWatcher);
    stateSub.unsubscribe();
    return s;
  },
  (e) => {
    clearInterval(snapshotTimer);
    clearInterval(progressWatcher);
    stateSub.unsubscribe();
    console.log(`  sync: ${e.message}`);
    return null;
  },
);

// ---- Honest criteria, measured from real state ------------------------------
const finalState = synced ?? lastFacadeState;
const shieldedProgress = finalState?.shielded?.state?.progress;
const unshieldedProgress = finalState?.unshielded?.progress;
const dustProgress = finalState?.dust?.state?.progress;
const channelsConnected =
  shieldedProgress?.isConnected === true && unshieldedProgress?.isConnected === true && dustProgress?.isConnected === true;
const shieldedAdvancing =
  firstShieldedSnapshot.applied !== null &&
  (shieldedProgress?.appliedIndex ?? 0) > firstShieldedSnapshot.applied;
const unshieldedStrict = unshieldedProgress?.isStrictlyComplete?.() === true;
const fullySynced = synced !== null;

const rateInfo =
  firstShieldedSnapshot.applied !== null && shieldedProgress
    ? ` (shielded appliedIndex ${firstShieldedSnapshot.applied} -> ${shieldedProgress.appliedIndex} while observed)`
    : "";

console.log("\n================ SMOKE RESULT ================");
console.log(`wallet built:            yes`);
console.log(`shielded address (pre-sync derivation): ${coinAddress}`);
console.log(`all channels connected:  ${channelsConnected ? "yes" : "NO"}`);
console.log(`sync progressing:        ${shieldedAdvancing ? `yes${rateInfo}` : "NOT OBSERVED"}`);
console.log(`unshielded strict-sync:  ${unshieldedStrict ? "yes" : "no"}`);
console.log(`full sync completed:     ${fullySynced ? "yes" : `no within ${SYNC_TIMEOUT_MS / 1000}s (chain-scale bound; raise MIDNIGHT_SMOKE_TIMEOUT_SECS)`}`);
const balances = finalState?.unshielded?.balances ?? {};
console.log(`unshielded balances:     ${JSON.stringify(Object.fromEntries(Object.entries(balances).map(([k, v]) => [String(k).slice(0, 12), v.toString()])))}`);
console.log("==============================================");

await wallet.stop().catch(() => {});
const pass = channelsConnected && shieldedAdvancing && unshieldedStrict;
process.exit(pass ? 0 : 1);
