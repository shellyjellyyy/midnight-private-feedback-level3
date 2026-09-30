#!/usr/bin/env node
// READ-ONLY diagnostic probe (no transactions are submitted).
//
// Why this exists: run 5 (2026-09-27) submitted a REAL dust-registration
// transaction that finalized SUCCESS on-chain (block 1,046,854), yet the local
// wallet's dust.balance stayed 0 for 15 minutes. The wallet's
// waitForSyncedState() never resolved in any run (30 min budgets), so we have
// no visibility into WHICH sync channel is incomplete or whether indices
// advance at all. This probe prints the raw SyncProgress of each channel
// (shielded / dust / unshielded) plus dust.balance and unshielded NIGHT.
//
//   node scripts/probe-sync-progress.mjs [seconds]
//
// Prints no secrets: the seed is registered with the redacting logger and is
// never echoed.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { firstValueFrom } from "rxjs";
import { rememberSecret, makeRedactingLogger } from "./lib-redacting-logger.mjs";

const DURATION_S = Number(process.argv[2] ?? "240");
const SAMPLE_EVERY_MS = 10_000;

const SEED = process.env.MIDNIGHT_PREVIEW_SEED?.trim() ||
  (existsSync(".admin-seed-preview") ? readFileSync(".admin-seed-preview", "utf8").trim() : undefined);
if (!SEED) {
  console.error("[BLOCKER] no admin seed available (MIDNIGHT_PREVIEW_SEED / .admin-seed-preview)");
  process.exit(2);
}
rememberSecret(SEED);

const logger = makeRedactingLogger();
const testkit = await import("@midnight-ntwrk/testkit-js-stable");
const protocolLedgerUrl = (await import("node:module")).createRequire(
  resolve("node_modules/@midnight-ntwrk/testkit-js-stable/package.json"),
).resolve("@midnight-ntwrk/midnight-js-protocol/ledger");
const protocolLedgerMod = await import(new URL(`file://${protocolLedgerUrl.replace(/\\/g, "/")}`).href);
const protocolLedger = protocolLedgerMod.default ?? protocolLedgerMod;

const networkIdMod = await import(
  new URL(
    `file://${resolve("node_modules/@midnight-ntwrk/testkit-js-stable/node_modules/@midnight-ntwrk/midnight-js-network-id/dist/index.mjs").replace(/\\/g, "/")}`,
  ).href
);
networkIdMod.setNetworkId("preview");

const prog = (p) => {
  if (!p) return "n/a";
  const f = (v) => (typeof v === "bigint" ? v.toString() : String(v));
  return `applied=${f(p.appliedIndex ?? p.appliedId ?? "?")} relWallet=${f(
    p.highestRelevantWalletIndex ?? p.highestTransactionId ?? "?",
  )} highest=${f(p.highestIndex ?? p.highestRelevantIndex ?? "?")} connected=${p.isConnected}`;
};

console.log(`== sync-progress probe: ${DURATION_S}s, sample every ${SAMPLE_EVERY_MS / 1000}s ==`);
const env = new testkit.PreviewTestEnvironment(logger);
env.proofServerContainer = { getUrl: () => "https://proof-server.preview.midnight.network", stop: async () => {} };
const envConfig = env.getEnvironmentConfiguration();

const wallet = await testkit.MidnightWalletProvider.build(logger, envConfig, SEED);
await wallet.start(false);
console.log("  wallet started (start(false)); sampling…");

const nightRaw = protocolLedger.unshieldedToken().raw;
const deadline = Date.now() + DURATION_S * 1000;
let last = null;
while (Date.now() < deadline) {
  const state = await firstValueFrom(wallet.wallet.state());
  let dust = 0n;
  try {
    const b = state.dust.balance(new Date());
    dust = typeof b === "bigint" ? b : (b?.balance ?? 0n);
  } catch {}
  const night = state.unshielded?.balances?.[nightRaw] ?? 0n;
  const line =
    `shielded{${prog(state.shielded?.state?.progress)}} dust{${prog(state.dust?.state?.progress)}} ` +
    `unshielded{${prog(state.unshielded?.progress)}} dustBalance=${dust} night=${night}`;
  console.log(`  [${new Date().toISOString()}] ${line}`);
  last = line;
  await new Promise((r) => setTimeout(r, SAMPLE_EVERY_MS));
}

console.log("== probe done ==");
await wallet.stop().catch(() => {});
process.exit(0);
