#!/usr/bin/env node
//
// MEMORY: two concurrent full chain syncs need a bigger V8 heap than the
// default (verified: OOM at ~3.5 GB). Run with:
//   node --max-old-space-size=8192 scripts/deploy-preview.mjs
/**
 * REAL deployment of the RETAINED (ledger-v8-era) Feedback artifact to the
 * live Midnight PREVIEW network + real end-to-end transaction testing — using
 * the stable (v8-era) SDK line, testkit-js 4.1.1, and the public Preview proof
 * server.
 *
 *   Fund-status phase:  node scripts/deploy-preview.mjs --fund-status
 *   Deploy + E2E phase: node scripts/deploy-preview.mjs
 *   Reuse + E2E phase:  node scripts/deploy-preview.mjs --contract <32-byte-hex>
 *                       (skips deployment entirely; re-validates the existing
 *                        contract against chain data before using it)
 *
 * Required node_modules patch (reproducible, idempotent, self-reverting):
 *   node scripts/patch-dust-empty-actions.mjs
 * Without it every contract CALL is rejected by the Preview mempool with
 * "Custom error: 117" (NotNormalized) because the wallet attaches an EMPTY
 * DustActions segment. See that script for the full causal chain.
 *
 * This is the retained-era counterpart of scripts/deploy.mjs (v9/Preprod),
 * which remains untouched. The two never mix toolchains:
 *
 *   scripts/deploy.mjs          v9  artifact managed/feedback       beta.8 stack
 *   scripts/deploy-preview.mjs  v8  artifact managed/feedback-v8    4.1.1 stack
 *
 * Era gate (mirror image of the v9 gate): the retained artifact is compiled
 * with compactc 0.31.1 / runtime 0.16.0 and can ONLY be deployed to a
 * ledger-v8 chain (protocolVersion < 2000000). Live Preview currently reports
 * protocolVersion 1000000 at height ~1,011,000. If Preview ever enacts the v9
 * fork, this script refuses to run and the v9 path takes over.
 *
 * Secrets policy (enforced, not aspirational):
 *   - MIDNIGHT_PREVIEW_SEED is read from the environment ONLY.
 *   - The participant seed lives only in the gitignored .participant-seed-preview.
 *   - The admin secret lives only in the gitignored .admin-secret-preview
 *     (separate from the Preprod files so the two deployments never share keys).
 *   - The shared redacting logger scrubs every SDK log line.
 *
 * Everything runs for real or fails loudly. No result is ever fabricated.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { firstValueFrom } from "rxjs";
import { rememberSecret, scrub, makeRedactingLogger } from "./lib-redacting-logger.mjs";
import { evaluateVerdict, verdictExitCode } from "./lib-deploy-verdict.mjs";

// ---------------------------------------------------------------------------
// 0. Configuration, fail-loudly.
// ---------------------------------------------------------------------------

const FUND_STATUS_MODE =
  process.argv.includes("--fund-status") || process.env.MIDNIGHT_FUND_STATUS === "1";

// Reuse an ALREADY-DEPLOYED Preview contract instead of deploying a new one.
//   node --max-old-space-size=8192 scripts/deploy-preview.mjs --contract <32-byte-hex>
// The address is the same 64-char hex form this script prints as
// "CONTRACT ADDRESS". It is still fully re-validated before use: the script
// re-reads the deployed state through the indexer, re-attaches with
// `findDeployedContract` (verifier-key byte match) and asserts the on-chain
// admin identity belongs to this run's admin wallet, so a stale or foreign
// address fails loudly instead of silently testing the wrong contract.
// Nothing is deployed and no contract-deployment transaction is broadcast.
const argContract = (() => {
  const i = process.argv.indexOf("--contract");
  return (i >= 0 && process.argv[i + 1] ? process.argv[i + 1].trim() : process.env.MIDNIGHT_PREVIEW_CONTRACT ?? "")
    .replace(/^0x/, "")
    .toLowerCase();
})();
const REUSE_CONTRACT = argContract !== "";
if (REUSE_CONTRACT && !/^[0-9a-f]{64}$/.test(argContract)) {
  console.error(`[BLOCKER] --contract expects a 32-byte hex contract address, got: ${argContract}`);
  process.exit(2);
}

// For a reproducible phase 1 -> phase 2 flow, the admin seed may be stored in
// the gitignored .admin-seed-preview file (like the participant seed); the
// MIDNIGHT_PREVIEW_SEED environment variable always takes precedence.
const ADMIN_SEED_FILE = ".admin-seed-preview";
const SEED = process.env.MIDNIGHT_PREVIEW_SEED?.trim() ||
  (existsSync(ADMIN_SEED_FILE) ? readFileSync(ADMIN_SEED_FILE, "utf8").trim() : undefined);
if (!SEED) {
  console.error(
    "\n[BLOCKER] MIDNIGHT_PREVIEW_SEED is not set.\n" +
      "  Generate a fresh seed locally (never commit it):\n" +
      "    node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"\n" +
      "  optionally persist it for both phases (gitignored):\n" +
      "    node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" > .admin-seed-preview\n" +
      "  then re-run:\n" +
      "    node --max-old-space-size=8192 scripts/deploy-preview.mjs --fund-status   # phase 1: addresses\n" +
      "    node --max-old-space-size=8192 scripts/deploy-preview.mjs                 # phase 2: deploy + E2E\n",
  );
  process.exit(2);
}

const ADMIN_SECRET_FILE = process.env.MIDNIGHT_ADMIN_SECRET_FILE_PREVIEW ?? ".admin-secret-preview";
const PARTICIPANT_SEED_FILE = ".participant-seed-preview";
const FUND_TIMEOUT_SECS = Number(process.env.MIDNIGHT_FUND_TIMEOUT_SECS ?? "900");
const NETWORK_ID = "preview";
const V9_FORK_PROTOCOL_VERSION = 2000000n;

const ARTIFACT_DIR = resolve("managed/feedback-v8");
const PROOF_SERVER = process.env.MIDNIGHT_PROOF_SERVER_PREVIEW ?? "https://proof-server.preview.midnight.network";
const FAUCET_WEB = "https://faucet.preview.midnight.network";

const logger = makeRedactingLogger();

// The stable midnight-js-contracts module — the same instance the testkit's
// provider wiring uses — loaded by explicit path (its package exports map is
// ESM-only, and a bare specifier here could dual-resolve to the hoisted v9
// copy of midnight-js-contracts).
const STABLE_CONTRACTS_ESM = resolve(
  "node_modules/@midnight-ntwrk/testkit-js-stable/node_modules/@midnight-ntwrk/midnight-js-contracts/dist/index.mjs",
);

// ---------------------------------------------------------------------------
// 1. v8-era toolchain imports (stable line only — never the beta.8 stack).
// ---------------------------------------------------------------------------

const testkit = await import("@midnight-ntwrk/testkit-js-stable");
const ledger8 = await import("@midnight-ntwrk/compact-runtime-ledger8");
// Stable (v8-era) type helpers. Resolved from the testkit's own nested copy so
// the ContractAddress class identity matches the providers created by
// initializeMidnightProviders below — a hoisted v9 instance would be a
// different class and fail `instanceof` checks inside the ledger bindings.
const stableTypes = await import(
  pathToFileURL(
    resolve(
      "node_modules/@midnight-ntwrk/testkit-js-stable/node_modules/@midnight-ntwrk/midnight-js-types/dist/index.mjs",
    ),
  ).href
);
const managedMod = await import(
  pathToFileURL(resolve(ARTIFACT_DIR, "contract/index.js")).href
);
managedMod.checkRuntimeVersion?.("0.16.0");

// bech32m address formatting from the stable wallet stack (the same codec the
// wallet UIs use to render mn addresses on Preview).
const addressFormat = await import(
  pathToFileURL(
    resolve("node_modules/@midnight-ntwrk/wallet-sdk-address-format/dist/index.js"),
  ).href
);

// Token-type equality is module-instance-bound: the NIGHT raw token used to
// filter UTXOs must come from the SAME ledger module the testkit's wallet
// stack resolves (this is the exact subpath testkit-js-stable itself imports
// for registerNightUtxosForDust). Resolved from the testkit's own require
// context so the stable nested copy is used, never the hoisted v9 ledger.
const protocolLedgerUrl = createRequire(
  resolve("node_modules/@midnight-ntwrk/testkit-js-stable/package.json"),
).resolve("@midnight-ntwrk/midnight-js-protocol/ledger");
const protocolLedgerMod = await import(pathToFileURL(protocolLedgerUrl).href);
const protocolLedger = protocolLedgerMod.default ?? protocolLedgerMod;

// Stable 4.1.1: midnight-js-network-id is plain module state that NOTHING sets
// on our behalf — the testkit only sets it inside its own getTestEnvironment()
// switch, which we bypass by constructing PreviewTestEnvironment directly.
// Without it, deployContract fails with "Network ID has not been configured.
// Call setNetworkId() before any wallet or contract operation." (observed live
// 2026-09-27). The testkit AND the nested contracts package both resolve to
// THIS module instance, so one call configures every consumer.
const networkIdMod = await import(
  pathToFileURL(
    resolve(
      "node_modules/@midnight-ntwrk/testkit-js-stable/node_modules/@midnight-ntwrk/midnight-js-network-id/dist/index.mjs",
    ),
  ).href
);
networkIdMod.setNetworkId(NETWORK_ID);
if (networkIdMod.getNetworkId() !== NETWORK_ID) {
  throw new Error(`setNetworkId verification failed: expected ${NETWORK_ID}`);
}

// Fail loudly, before any long chain sync, if the required node_modules patch
// is missing. Without it the wallet attaches an EMPTY DustActions segment to
// every contract call and the Preview mempool rejects it with
// "Custom error: 117" (NotNormalized, ledger dust.rs:768) after a full deploy
// has already been broadcast. Repair: node scripts/patch-dust-empty-actions.mjs
const DUST_WALLET_TRANSACTING = "node_modules/@midnight-ntwrk/wallet-sdk-dust-wallet/dist/v1/Transacting.js";
if (!readFileSync(DUST_WALLET_TRANSACTING, "utf8").includes("patch-dust-empty-actions.mjs")) {
  throw new Error(
    "Required patch is not applied to " +
      DUST_WALLET_TRANSACTING +
      ".\n  Run:  node scripts/patch-dust-empty-actions.mjs\n" +
      "  Without it every contract call is rejected with ledger error 117 (NotNormalized).",
  );
}

// The CompiledContract builder MUST come from the same compact-js instance the
// stable testkit uses (its nested 2.5.1), so the contract object the testkit
// deploys is built by the exact library version the deploy path expects.
function loadStableCompactJs() {
  const testkitEntry = createRequire(import.meta.url).resolve("@midnight-ntwrk/testkit-js-stable");
  const reqFromTestkit = createRequire(testkitEntry);
  const nestedPkgJson = reqFromTestkit.resolve("@midnight-ntwrk/compact-js/package.json");
  const esmEntry = join(dirname(nestedPkgJson), "dist", "esm", "index.js");
  if (!existsSync(esmEntry)) {
    throw new Error(`stable compact-js ESM entry not found at ${esmEntry}`);
  }
  return import(pathToFileURL(esmEntry).href);
}
const { CompiledContract } = await loadStableCompactJs();

// ---------------------------------------------------------------------------
// 2. Pure helpers over the ledger8 runtime (same construction as deploy.mjs).
// ---------------------------------------------------------------------------

const bytes32 = new ledger8.CompactTypeBytes(32);
const vector2 = new ledger8.CompactTypeVector(2, bytes32);
const tagPad = (text) => {
  const out = new Uint8Array(32);
  out.set(Buffer.from(text, "ascii").subarray(0, 32));
  return out;
};
const TAG_ADMIN_IDENTITY = tagPad("midnight:feedback:admin:identity");
const TAG_COMMITMENT = tagPad("midnight:feedback:commitment");
const taggedHash2 = (tag, value) => ledger8.persistentHash(vector2, [tag, value]);
const adminIdentityOf = (secret) => taggedHash2(TAG_ADMIN_IDENTITY, secret);
const commitmentOf = (secret) => taggedHash2(TAG_COMMITMENT, secret);
const ZERO32 = new Uint8Array(32);
const sha256 = (buf) => createHash("sha256").update(buf).digest();

const ledgerOfChainState = (chainState) =>
  managedMod.ledger(
    chainState && chainState.data !== undefined && !(chainState instanceof ledger8.StateValue)
      ? chainState.data
      : chainState,
  );

// ---------------------------------------------------------------------------
// 3. Compiled contract instances (witness sets identical in shape to deploy.mjs).
// ---------------------------------------------------------------------------

let adminRuntimeSecret = ZERO32; // set in main before any proving happens

const adminWitnessSet = {
  participantSecret: (ctx) => [ctx.privateState, ZERO32],
  participantMerklePath: (ctx, leaf) => {
    const path = ctx.ledger.participants.findPathForLeaf(leaf);
    if (path === undefined) throw new Error("leaf not registered in the participants tree");
    return [ctx.privateState, path];
  },
  feedbackRating: (ctx) => [ctx.privateState, ctx.privateState.rating],
  feedbackComment: (ctx) => [ctx.privateState, ctx.privateState.commentDigest],
  adminSecret: (ctx) => [ctx.privateState, adminRuntimeSecret],
};

const participantWitnessSet = {
  participantSecret: (ctx) => [ctx.privateState, ctx.privateState.secret],
  participantMerklePath: (ctx, leaf) => {
    const path = ctx.ledger.participants.findPathForLeaf(leaf);
    if (path === undefined) throw new Error("This secret is not registered for this survey.");
    return [ctx.privateState, path];
  },
  feedbackRating: (ctx) => [ctx.privateState, ctx.privateState.rating],
  feedbackComment: (ctx) => [ctx.privateState, ctx.privateState.commentDigest],
  adminSecret: (ctx) => [ctx.privateState, ZERO32],
};

async function makeCompiled(witnessSet) {
  return CompiledContract.make("Feedback", managedMod.Contract).pipe(
    CompiledContract.withWitnesses(witnessSet),
    CompiledContract.withCompiledFileAssets(ARTIFACT_DIR.replace(/\\/g, "/")),
  );
}

// ---------------------------------------------------------------------------
// 4. Preflight — verify every external prerequisite empirically.
// ---------------------------------------------------------------------------

const INDEXER_HTTP = "https://indexer.preview.midnight.network/api/v4/graphql";
const NODE_HTTP = "https://rpc.preview.midnight.network";

async function preflight() {
  console.log("== Preflight ==");
  const gql = await fetch(INDEXER_HTTP, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "{ __typename }" }),
    signal: AbortSignal.timeout(20000),
  })
    .then((r) => `HTTP ${r.status}`)
    .catch((e) => `FAILED: ${e.message}`);
  console.log(`  indexer:      ${gql}`);

  const rpc = await fetch(NODE_HTTP, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "system_chain", params: [] }),
    signal: AbortSignal.timeout(20000),
  })
    .then((r) => r.json())
    .then((j) => `HTTP OK, chain=${j.result}`)
    .catch((e) => `FAILED: ${e.message}`);
  console.log(`  node:         ${rpc}`);

  const proof = await fetch(`${PROOF_SERVER}/health`, { signal: AbortSignal.timeout(20000) })
    .then((r) => `HTTP ${r.status}`)
    .catch((e) => `FAILED: ${e.message}`);
  console.log(`  proof server: ${PROOF_SERVER} -> ${proof}`);

  // Era gate: the retained v8 artifact requires a PRE-fork chain.
  let chainTip = null;
  try {
    const j = await fetch(INDEXER_HTTP, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ block { height hash protocolVersion } }" }),
      signal: AbortSignal.timeout(20000),
    }).then((r) => r.json());
    chainTip = j?.data?.block ?? null;
  } catch {
    chainTip = null;
  }
  if (chainTip) {
    console.log(`  chain tip:    height=${chainTip.height} protocolVersion=${chainTip.protocolVersion} (retained v8 artifact requires < ${V9_FORK_PROTOCOL_VERSION})`);
  } else {
    console.log("  chain tip:    UNAVAILABLE (could not read block info from the indexer)");
  }

  if (!existsSync(resolve(ARTIFACT_DIR, "compiler/contract-info.json"))) {
    console.error(`\n[BLOCKER] retained artifact missing — run: npm run compile:v8`);
    process.exit(3);
  }
  console.log(`  artifact:     ${ARTIFACT_DIR} present (v8: keys + bzkir verified by provider at use time)`);

  const failed = [gql, rpc, proof].filter((s) => s.startsWith("FAILED"));
  if (failed.length > 0) {
    console.error("\n[BLOCKER] Preview prerequisites failed preflight:", failed);
    process.exit(3);
  }
  return { chainTip };
}

function eraGate(chainTip) {
  if (!chainTip) return "[ERA] Could not read the Preview chain tip — refusing to deploy without era verification.";
  if (BigInt(chainTip.protocolVersion) >= V9_FORK_PROTOCOL_VERSION) {
    return (
      `[ERA] Preview chain: protocolVersion ${chainTip.protocolVersion} at height ${chainTip.height} is AT OR ABOVE ` +
      `the ledger-v9 fork threshold (${V9_FORK_PROTOCOL_VERSION}). The retained v8 artifact is era-pinned to ledger-v8 ` +
      `and must not be deployed to a v9-era chain; use the v9 path (scripts/deploy.mjs) instead.`
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// 5. Wallets (real Node wallets from the stable testkit).
// ---------------------------------------------------------------------------

function buildEnvConfig() {
  const env = new testkit.PreviewTestEnvironment(logger);
  env.proofServerContainer = {
    getUrl: () => PROOF_SERVER,
    stop: async () => {},
  };
  const envConfig = env.getEnvironmentConfiguration();
  console.log("  environment configuration ready (Preview endpoints + public proof server)");
  return { env, envConfig };
}

async function startWalletCore(envConfig, seed, label) {
  console.log(`  building ${label} wallet (seed redacted)…`);
  const wallet = await testkit.MidnightWalletProvider.build(logger, envConfig, seed);
  await wallet.start(false);
  const coinAddress = await (async () => {
    const s = await testkit.getInitialShieldedState(wallet.wallet.shielded);
    return s.address.coinPublicKeyString();
  })();
  console.log(`  ${label} wallet ready: coin address ${coinAddress}`);
  return { wallet, coinAddress };
}

/** bech32m (mn_addr_preview…) rendering of the wallet's unshielded address —
 *  the form the faucet/explorer tooling expects. Verified empirically against
 *  the address-format codec used by the official wallet UIs. */
async function unshieldedAddressOf(core) {
  const addr = await core.wallet.wallet.unshielded.getAddress();
  const wrapped = new addressFormat.UnshieldedAddress(Buffer.from(addr.data));
  return addressFormat.MidnightBech32m.encode("preview", wrapped).asString();
}

async function boundedSync(core, ms) {
  const timeoutMs = ms ?? 180000;
  try {
    await Promise.race([
      core.wallet.wallet.waitForSyncedState(),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`sync timeout after ${timeoutMs}ms`)), timeoutMs)),
    ]);
    return true;
  } catch (e) {
    console.log(`  sync: ${scrub(e instanceof Error ? e.message : String(e)).slice(0, 120)}`);
    return false;
  }
}

/** Sync of the UNSHIELDED channel only — this is where faucet NIGHT lands,
 *  and it completes in seconds (unlike the full shielded catch-up). */
async function unshieldedSynced(core, ms = 120000) {
  return Promise.race([
    core.wallet.wallet.unshielded.waitForSyncedState(),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`unshielded sync timeout after ${ms}ms`)), ms)),
  ]);
}

function unshieldedTotal(unshieldedState) {
  const balances = unshieldedState?.balances ?? {};
  return Object.values(balances).reduce((a, b) => a + b, 0n);
}

/**
 * Funding: NIGHT (unshielded) funds the wallet, but the stable 4.1.1 dust
 * wallet pays FEES in DUST, which accrues ONLY from NIGHT UTXOs explicitly
 * registered for dust generation via a real registration transaction (see
 * ensureDustRegistered / waitForDustAccrual below). The Preview faucet API enforces a CAPTCHA (verified
 * 2026-09-25: POST /api/drips with a dummy token -> 403 "Captcha verification
 * failed"), so automated drips are attempted on a best-effort basis only and
 * are EXPECTED to be rejected; real funding is a HUMAN step through the
 * official faucet web app (FAUCET_WEB). An unfunded wallet after the deadline
 * is a loud blocker with the exact address to fund — never a simulated
 * success.
 */
async function ensureFunded(env, envConfig, core, label) {
  const deadline = Date.now() + FUND_TIMEOUT_SECS * 1000;
  const faAddr = await unshieldedAddressOf(core);
  let night = unshieldedTotal(await unshieldedSynced(core));
  for (;;) {
    if (night > 0n) break;
    if (Date.now() > deadline) {
      console.error(
        `\n[BLOCKER] ${label} wallet is not funded after ${FUND_TIMEOUT_SECS}s (NIGHT=${night}).\n` +
          `  Fund this Preview address manually via the official faucet (${FAUCET_WEB} or the wallet UI):\n` +
          `  ${label} faucet address: ${faAddr}\n` +
          `  Then re-run this script. No simulated funding is performed.\n`,
      );
      await env.shutdown().catch(() => {});
      process.exit(4);
    }
    console.log(`  ${label}: NIGHT=${night} — requesting a faucet drip…`);
    try {
      await new testkit.FaucetClient(envConfig.faucet, logger).requestTokens(faAddr);
    } catch (e) {
      const status = e?.response?.status;
      console.log(
        `  faucet request ${status ? `rejected (HTTP ${status})` : `failed: ${scrub(e.message).slice(0, 120)}`}`,
      );
    }
    await new Promise((r) => setTimeout(r, 30000));
    night = unshieldedTotal(await unshieldedSynced(core));
  }
  console.log(`  ${label} funded: NIGHT=${night}`);
  return night;
}

// ---------------------------------------------------------------------------
// 5b. DUST generation (stable v1 dust wallet).
// ---------------------------------------------------------------------------
// Fees on the stable wallet stack are paid in DUST, and DUST accrues only
// from NIGHT UTXOs REGISTERED for dust generation (a real on-chain
// registration transaction, exactly like the testkit's official waitForFunds
// helper does in testkit-js-stable/dist/index.mjs). Our script intentionally
// calls wallet.start(false), so the same steps must run here. Run 4
// (2026-09-27) failed with "Wallet.InsufficientFunds: could not balance dust"
// precisely because no NIGHT UTXO had ever been registered.

function balanceOfDust(state) {
  try {
    const b = state?.dust?.balance?.(new Date());
    if (typeof b === "bigint") return b;
    if (b && typeof b === "object" && typeof b.balance === "bigint") return b.balance;
    return 0n;
  } catch {
    return 0n;
  }
}

function unregisteredNightUtxos(state) {
  const raw = protocolLedger.unshieldedToken().raw;
  const coins = state?.unshielded?.availableCoins ?? [];
  return coins.filter(
    (coin) => coin?.utxo?.type === raw && coin?.meta?.registeredForDustGeneration === false,
  );
}

/** Register available NIGHT UTXOs for dust generation (real on-chain tx,
 *  identical to the testkit's official registerNightUtxosForDust helper). */
async function registerNightUtxosForDust(core, label) {
  const state = await firstValueFrom(core.wallet.wallet.state());
  const unregistered = unregisteredNightUtxos(state);
  if (unregistered.length === 0) {
    console.log(`  ${label}: no unregistered NIGHT UTXOs available (nothing to register)`);
    return undefined;
  }
  console.log(`  ${label}: registering ${unregistered.length} NIGHT UTXO(s) for dust generation (real transaction)…`);
  const recipe = await core.wallet.wallet.registerNightUtxosForDustGeneration(
    unregistered,
    core.wallet.unshieldedKeystore.getPublicKey(),
    (payload) => core.wallet.unshieldedKeystore.signData(payload),
  );
  const finalized = await core.wallet.wallet.finalizeRecipe(recipe);
  const txId = await core.wallet.wallet.submitTransaction(finalized);
  console.log(`  ${label}: dust registration tx submitted: ${txId}`);
  return txId;
}

// Per-channel sync progress (probe-verified field names; the unshielded
// channel uses appliedId/highestTransactionId, the shielded/dust channels use
// appliedIndex/highestRelevantWalletIndex).
function progressPart(p) {
  if (!p) return "n/a";
  const f = (v) => (typeof v === "bigint" ? v.toString() : String(v));
  const applied = f(p.appliedIndex ?? p.appliedId ?? "?");
  const target = f(p.highestRelevantWalletIndex ?? p.highestTransactionId ?? "?");
  return `${applied}/${target}${p.isConnected === false ? " (disconnected)" : ""}`;
}
function syncProgressOf(state) {
  return (
    `dust{${progressPart(state?.dust?.state?.progress)}} ` +
    `shielded{${progressPart(state?.shielded?.state?.progress)}} ` +
    `unshielded{${progressPart(state?.unshielded?.progress)}}`
  );
}

/** True when a channel has consumed every event the node has reported to it,
 * i.e. the wallet is no longer catching up. `target` is
 * `highestRelevantWalletIndex`, which only advances for events relevant to THIS
 * wallet, so it converges rather than chasing the whole chain. */
function channelSynced(p) {
  if (!p) return false;
  const applied = p.appliedIndex ?? p.appliedId;
  const target = p.highestRelevantWalletIndex ?? p.highestTransactionId;
  if (applied == null || target == null) return false;
  try {
    return BigInt(applied) >= BigInt(target);
  } catch {
    return false;
  }
}

/** Confirm a dust-registration transaction really finalized on-chain via an
 * independent GraphQL check against the Preview indexer (the wallet's own
 * unshielded flag is wallet-local; this is the external truth). */
async function assertRegistrationFinalized(label, txId) {
  const deadline = Date.now() + 180000;
  for (;;) {
    const res = await fetch(INDEXER_HTTP, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query:
          "query ($o: TransactionOffset!) { transactions(offset: $o) { id block { height } ... on RegularTransaction { transactionResult { status } } } }",
        variables: { o: { identifier: txId } },
      }),
    });
    const json = await res.json().catch(() => null);
    // `transactions(offset:)` returns an ARRAY (verified live); treating it as
    // an object made status read as "unknown" forever (run 11, 2026-09-28).
    const list = json?.data?.transactions;
    const tx = Array.isArray(list) ? (list[0] ?? null) : (list ?? null);
    if (tx) {
      const status = tx.transactionResult?.status ?? "unknown";
      if (status === "SUCCESS") {
        console.log(`  ${label}: registration tx finalized SUCCESS (block ${tx.block?.height})`);
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(`${label}: dust registration tx ${txId} finalized with status=${status} — refusing to continue`);
      }
    } else if (Date.now() > deadline) {
      throw new Error(`${label}: dust registration tx ${txId} not found on the indexer after 180s`);
    }
    await new Promise((r) => setTimeout(r, 15000));
  }
}

/** Register NIGHT UTXOs for dust generation IF the wallet still sees
 * unregistered ones (real on-chain tx; identical to the testkit's official
 * helper), then verify finalization through the indexer. No accrual waiting
 * happens here — see waitForDustAccrual. */
async function ensureDustRegistered(core, label) {
  const state = await firstValueFrom(core.wallet.wallet.state());
  const dust = balanceOfDust(state);
  if (dust > 0n) {
    console.log(`  ${label}: DUST already available (${dust}) — no registration needed`);
    return;
  }
  const txId = await registerNightUtxosForDust(core, label);
  if (txId === undefined) {
    console.log(
      `  ${label}: no unregistered NIGHT UTXOs — registration already on-chain from a prior run; ` +
        `accrual appears once the dust scan reaches it (${syncProgressOf(state)})`,
    );
    return;
  }
  await assertRegistrationFinalized(label, txId);
}

/** Wait until the wallet reports a positive spendable DUST balance.
 *
 * The balance is computed from the LOCAL dust-wallet state
 * (state.state.walletBalance(time)), so it stays 0 until the dust channel's
 * chain-scale scan reaches our registered coins (probe 2026-09-27: ~30
 * indices/s toward ~256,000 ≈ 2.4 h from scratch — and wallet state is never
 * persisted, so every run restarts that scan at 0). Sync runs in the
 * background on its own; this loop only observes, with per-minute progress
 * logging so a stall is diagnosable from the log alone. */
async function waitForDustAccrual(core, label, ms) {
  const timeoutMs = ms ?? Number(process.env.MIDNIGHT_DUST_WAIT_MS ?? "21600000"); // 6 h default
  const started = Date.now();
  const deadline = started + timeoutMs;
  let state = await firstValueFrom(core.wallet.wallet.state());
  for (;;) {
    const dust = balanceOfDust(state);
    const elapsed = Math.round((Date.now() - started) / 1000);
    // A non-zero DUST balance is NOT sufficient on its own. Run 3
    // (2026-09-29 20:31 local) returned the moment the balance went positive,
    // at dust{256009/257063} — still ~0.2% behind the node — and the resulting
    // DEPLOY was rejected with `1010 ... Custom error: 170`
    // (InvalidDustSpendProof). Runs 1 and 2 happened to return only at
    // dust{256045/256045}, fully caught up, and their deploys were accepted.
    // The wallet composes and balances against its own synced view, so never
    // broadcast until the DUST channel has consumed everything the node has
    // reported for this wallet.
    const dustCaughtUp = channelSynced(state?.dust?.state?.progress);
    if (dust > 0n && dustCaughtUp) {
      console.log(`  ${label}: DUST=${dust} available after ${elapsed}s (${syncProgressOf(state)})`);
      return dust;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${label}: dust did not accrue within ${timeoutMs}ms (dust=${dust}; last progress ${syncProgressOf(state)})`,
      );
    }
    console.log(
      dust > 0n
        ? `  ${label}: DUST=${dust} positive but DUST channel still catching up; not broadcasting yet. (${elapsed}s elapsed) ${syncProgressOf(state)}`
        : `  ${label}: waiting for DUST… (${elapsed}s elapsed) ${syncProgressOf(state)}`,
    );
    await new Promise((r) => setTimeout(r, 60000));
    state = await firstValueFrom(core.wallet.wallet.state());
  }
}

// ---------------------------------------------------------------------------
// 6. Provider helpers.
// ---------------------------------------------------------------------------

const FEEDBACK_PRIVATE_STATE_ID = "feedbackPrivateState";

/**
 * Log-only submission diagnostic.
 *
 * Live Preview runs (2026-09-28) deployed successfully but had EVERY call
 * transaction rejected from the mempool with
 *   1010: Invalid Transaction: Custom error: 117
 * i.e. LedgerApiError::MalformedTransaction::NotNormalized, roughly 12 s after
 * the deploy. In the retained ledger (midnight-ledger 8.1.2) that variant is
 * raised from exactly four places:
 *   dust.rs:770  DustActions present but with NEITHER spends NOR registrations
 *   verify.rs:1824 two consecutive Op::Noop in a transcript program
 *   verify.rs:1762/1774 maintenance-signature ordering (needs a maintain op)
 *   verify.rs:358  new contract state with maintenance_authority.counter != 0
 * The contract issues no maintain operations, and a local rehearsal
 * (createUnprovenCallTxFromInitialStates, no wallet, no submission) shows the
 * registerParticipant/setSurveyOpen transcripts contain no Op::Noop at all, so
 * the transcript trigger is already excluded. That leaves the DUST trigger,
 * which is checkable here.
 *
 * `balanceTx` is the single choke point midnight-js-contracts uses for BOTH
 * deploy and call (submitTxCore), so wrapping it records the exact shape of
 * every transaction about to be broadcast. This is observation only: it never
 * mutates the transaction and never changes control flow.
 */
function installSubmissionDiagnostics(walletProvider, core, label) {
  const original = walletProvider.balanceTx.bind(walletProvider);
  walletProvider.balanceTx = async (tx, ttl) => {
    const finalized = await original(tx, ttl);
    const rec = { label };
    const safe = (name, fn) => {
      try {
        rec[name] = fn();
      } catch (e) {
        rec[name] = `unreadable(${scrub(e instanceof Error ? e.message : String(e)).slice(0, 80)})`;
      }
    };
    // `FinalizedTransaction` is `Transaction<SignatureEnabled, Proof, Binding>`
    // and exposes its intents as a Map keyed by segment id -- there is no
    // singular `.intent` (run 3 logged nulls for every field until this was
    // corrected). Reading is safe on a bound intent; only *writing* throws.
    const segs = [];
    let dustPresent = false;
    let dustSpends = 0;
    let dustRegs = 0;
    safe("segments", () => {
      const intents = finalized?.intents;
      if (!intents) return "no-intents-map";
      for (const [segmentId, intent] of intents) {
        const entry = { segmentId };
        try {
          entry.actions = intent?.actions?.length ?? null;
        } catch (e) {
          entry.actions = `unreadable(${scrub(e instanceof Error ? e.message : String(e)).slice(0, 60)})`;
        }
        let da = null;
        try {
          da = intent?.dustActions ?? null;
        } catch {
          da = null;
        }
        entry.dustActionsPresent = da != null;
        if (da != null) {
          dustPresent = true;
          try {
            dustSpends += da.spends?.length ?? 0;
            dustRegs += da.registrations?.length ?? 0;
            entry.dustSpends = da.spends?.length ?? 0;
            entry.dustRegistrations = da.registrations?.length ?? 0;
          } catch (e) {
            entry.dustDetail = `unreadable(${scrub(e instanceof Error ? e.message : String(e)).slice(0, 60)})`;
          }
        }
        segs.push(entry);
      }
      return segs;
    });
    // dust.rs:770 fires when a DustActions is present with NEITHER spends NOR
    // registrations. Reproduced live as error 117 on every call transaction.
    rec.dustActionsPresent = dustPresent;
    rec.dustSpends = dustSpends;
    rec.dustRegistrations = dustRegs;
    rec.wouldTriggerEmptyDustActions = dustPresent && dustSpends === 0 && dustRegs === 0;
    try {
      rec.dustBalance = balanceOfDust(await firstValueFrom(core.wallet.wallet.state())).toString();
    } catch (e) {
      rec.dustBalance = `unreadable(${scrub(e instanceof Error ? e.message : String(e)).slice(0, 60)})`;
    }
    console.log(`  [tx-shape:${label}] ${JSON.stringify(rec)}`);
    return finalized;
  };
}

async function readTally(providers, address) {
  const state = await providers.publicDataProvider.queryContractState(address);
  if (!state) return null;
  const l = ledgerOfChainState(state);
  return {
    participantCount: l.participantCount,
    responseCount: l.responseCount,
    rating1: l.rating1,
    rating2: l.rating2,
    rating3: l.rating3,
    rating4: l.rating4,
    rating5: l.rating5,
    surveyOpen: l.surveyOpen,
    usedNullifiers: l.usedNullifiers.size(),
  };
}

async function assertFinalized(providers, txId, what) {
  const record = await providers.publicDataProvider.watchForTxData(txId);
  const status = record.status ?? "unknown";
  const segmentStatusMap = record.tx?.segmentStatusMap;
  const failedSegments =
    segmentStatusMap === undefined
      ? []
      : Array.from(segmentStatusMap.entries()).filter(([, s]) => s !== "SegmentSuccess");
  const ok = status === "SucceedEntirely" && failedSegments.length === 0;
  console.log(
    `  ${what}: status=${status}${failedSegments.length ? ` failedSegments=[${failedSegments.map(([i]) => i).join(",")}]` : ""}`,
  );
  return { ok, status, txId };
}

async function findContract(providers, compiled, address, currentPrivateState) {
  const { findDeployedContract } = await import(pathToFileURL(STABLE_CONTRACTS_ESM).href);
  const options = {
    compiledContract: compiled,
    contractAddress: address,
    privateStateId: FEEDBACK_PRIVATE_STATE_ID,
  };
  // Stable 4.1.1: findDeployedContract scopes the private-state provider to the
  // contract address ITSELF and, when both privateStateId and initialPrivateState
  // are given, stores the initial private state itself. A bare provider.set()
  // BEFORE scoping throws ("Contract address not set. Call setContractAddress()...")
  // — a real failure observed on the first live run 2026-09-27. Omit the key
  // entirely when re-attaching without fresh per-call state (admin handles).
  if (currentPrivateState !== undefined) options.initialPrivateState = currentPrivateState;
  return findDeployedContract(providers, options);
}

async function participantReady(participantProviders, participantCompiled, address, secret, rating, commentDigest) {
  // Each re-find rewrites the stored per-contract private state, configuring the
  // NEXT callTx's witnesses (secret, rating, commentDigest) — same semantics the
  // old pre-set() had, but through the stable provider's supported path.
  return findContract(participantProviders, participantCompiled, address, {
    secret,
    commentDigest,
    rating: BigInt(rating),
  });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const report = { deployment: null, transactions: [], negativeTests: [] };

try {
  const { chainTip } = await preflight();
  rememberSecret(SEED);

  console.log("== Environment ==");
  const { env, envConfig } = buildEnvConfig();

  // Participant seed: deterministic across phases, gitignored, era-separated.
  let seed2 = process.env.MIDNIGHT_PARTICIPANT_SEED_PREVIEW?.trim();
  let seed2Origin = "from MIDNIGHT_PARTICIPANT_SEED_PREVIEW";
  if (!seed2) {
    if (existsSync(PARTICIPANT_SEED_FILE)) {
      seed2 = readFileSync(PARTICIPANT_SEED_FILE, "utf8").trim();
      seed2Origin = `loaded from ${PARTICIPANT_SEED_FILE}`;
    } else {
      seed2 = Buffer.from(randomBytes(32)).toString("hex");
      writeFileSync(PARTICIPANT_SEED_FILE, seed2 + "\n", { mode: 0o600 });
      seed2Origin = `freshly generated, stored (gitignored) in ${PARTICIPANT_SEED_FILE}`;
    }
  }
  rememberSecret(seed2);

  console.log("== Admin wallet (from MIDNIGHT_PREVIEW_SEED) ==");
  const adminCore = await startWalletCore(envConfig, SEED, "admin");
  console.log("== Participant wallet ==");
  console.log(`  participant seed ${seed2Origin}`);
  const participantCore = await startWalletCore(envConfig, seed2, "participant");

  if (FUND_STATUS_MODE) {
    const era = eraGate(chainTip);
    if (era) console.log(`\n  WARNING: ${era}\n`);
    // Addresses derive from the seed alone — no full chain sync needed here
    // (a full sync is also memory-heavy; balances are read in phase 2).
    const adminFa = await unshieldedAddressOf(adminCore);
    const participantFa = await unshieldedAddressOf(participantCore);
    console.log("\n================ FUNDING STATUS (phase 1, Preview) ================");
    console.log(`network:            ${NETWORK_ID}`);
    console.log(`admin coin address: ${adminCore.coinAddress}`);
    console.log(`admin faucet addr:  ${adminFa}`);
    console.log(`participant coin:   ${participantCore.coinAddress}`);
    console.log(`participant faucet: ${participantFa}`);
    console.log(`faucet:             ${FAUCET_WEB} (automated drips are attempted in phase 2 before blocking)`);
    console.log("next: fund both addresses, then run phase 2: node scripts/deploy-preview.mjs");
    await env.shutdown().catch(() => {});
    process.exit(0);
  }

  const era = eraGate(chainTip);
  if (era) {
    console.error(`\n[BLOCKER] ${era}\nNo deployment was attempted; nothing has been fabricated.`);
    await env.shutdown().catch(() => {});
    process.exit(6);
  }

  console.log("== Funding check ==");
  const adminNight = await ensureFunded(env, envConfig, adminCore, "admin");
  const participantNight = await ensureFunded(env, envConfig, participantCore, "participant");

  // Register BEFORE waiting: a sync-progress probe (2026-09-27,
  // scripts/probe-sync-progress.mjs) showed the unshielded channel completes
  // within seconds while the dust channel applies only ~30 indices/s toward
  // ~256,000 (≈ 2.4 h from scratch), restarted at 0 on every run because
  // wallet state is never persisted. Registering first puts our dust coins
  // on-chain early so the scan finds them; waiting for a "full sync" first
  // (what runs 4–5 did) burned 30–60 min and STILL raced the scan, which is
  // why run 5's registration finalized (block 1,046,854) yet dust stayed 0.
  console.log("== Dust generation registration (real on-chain txs; unshielded channel only) ==");
  await ensureDustRegistered(adminCore, "admin");
  await ensureDustRegistered(participantCore, "participant");

  console.log("== Waiting for admin DUST accrual (background chain-scale scans; progress-logged) ==");
  const adminDust = await waitForDustAccrual(adminCore, "admin");
  // Participant dust accrues concurrently in the background; it is gated
  // right before the participant's first real transaction so the deploy is
  // not serialized behind both scans.
  let participantDust = 0n;

  console.log("== Admin secret handling ==");
  let adminSecret;
  let adminSecretOrigin;
  if (existsSync(ADMIN_SECRET_FILE)) {
    adminSecret = new Uint8Array(Buffer.from(readFileSync(ADMIN_SECRET_FILE, "utf8").trim(), "hex"));
    adminSecretOrigin = `loaded from ${ADMIN_SECRET_FILE}`;
  } else {
    adminSecret = randomBytes(32);
    writeFileSync(ADMIN_SECRET_FILE, Buffer.from(adminSecret).toString("hex") + "\n", { mode: 0o600 });
    adminSecretOrigin = `freshly generated, stored (gitignored) in ${ADMIN_SECRET_FILE}`;
  }
  rememberSecret(adminSecret);
  adminRuntimeSecret = adminSecret;
  const adminIdentity = adminIdentityOf(adminSecret);
  console.log(`  admin secret ${adminSecretOrigin}`);
  console.log(`  adminIdentity (public constructor arg): ${Buffer.from(adminIdentity).toString("hex")}`);

  console.log(
    REUSE_CONTRACT
      ? "== Reusing EXISTING Preview Feedback contract (v8 artifact) — no new deployment =="
      : "== Deploying RETAINED Feedback (v8 artifact) to Preview ==",
  );
  const adminCompiled = await makeCompiled(adminWitnessSet);
  const { deployContract } = await import(pathToFileURL(STABLE_CONTRACTS_ESM).href);
  const { initializeMidnightProviders } = testkit;

  const adminProviders = initializeMidnightProviders(adminCore.wallet, envConfig, {
    privateStateStoreName: "feedback-preview-admin",
    zkConfigPath: ARTIFACT_DIR.replace(/\\/g, "/"),
  });
  // NOTE (stable 4.1.1): no explicit pre-deploy privateStateProvider.set() here.
  // submitDeployTx scopes the provider to the new contract address AFTER the
  // deploy succeeds and then stores initialPrivateState itself. Pre-setting
  // before scoping throws "Contract address not set" (observed live 2026-09-27);
  // the beta.8 provider used by scripts/deploy.mjs tolerated it — this era's does not.
  installSubmissionDiagnostics(adminProviders.walletProvider, adminCore, "admin");

  // The dust wallet accrues spendable DUST continuously from registered
  // NIGHT; a balancing attempt that races accrual can fail with
  // "Wallet.InsufficientFunds: could not balance dust" (run 4). One bounded
  // retry after a real accrual wait. A balancing failure happens BEFORE
  // submission, so nothing was ever broadcast — a retry cannot double-deploy.
  const deployOnce = () => {
    console.log("  composing + proving the deployment transaction (real proving via the public Preview proof server)…");
    return deployContract(adminProviders, {
      compiledContract: adminCompiled,
      args: [adminIdentity],
      privateStateId: FEEDBACK_PRIVATE_STATE_ID,
      initialPrivateState: { secret: ZERO32, commentDigest: ZERO32, rating: 0n },
    });
  };
  let deployed = null;
  if (REUSE_CONTRACT) {
    console.log(`  requested address: ${argContract}`);
  } else {
    try {
      deployed = await deployOnce();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/could not balance dust|InsufficientFunds/i.test(msg)) throw e;
      console.log(`  deploy balancing hit dust insufficiency (${scrub(msg).slice(0, 120)}) — waiting for dust accrual and retrying once…`);
      await new Promise((r) => setTimeout(r, 60000));
      await boundedSync(adminCore, 300000).catch(() => {});
      const state = await firstValueFrom(adminCore.wallet.wallet.state());
      const dustNow = balanceOfDust(state);
      if (dustNow === 0n) throw e;
      console.log(`  DUST now ${dustNow} — retrying deployment`);
      deployed = await deployOnce();
    }
  }

  // Rebuild the ledger's own ContractAddress from the 32 bytes using the SAME
  // stable (v8-era) type module the deploy path uses, so a wrong address
  // fails here — before any transaction work — rather than mid-E2E.
  const address = deployed
    ? deployed.deployTxData.public.contractAddress
    : stableTypes.asContractAddress(argContract);
  const addressStr = deployed ? String(address) : argContract;
  if (deployed) {
    const deployTxId = deployed.deployTxData.public.txId;
    const deployStatus = deployed.deployTxData.public.status;
    const deployBlockHeight = deployed.deployTxData.public.blockHeight;
    console.log(`  CONTRACT ADDRESS: ${addressStr}`);
    console.log(`  deploy txId:      ${deployTxId}`);
    console.log(`  deploy status:    ${deployStatus} (block ${deployBlockHeight})`);
  } else {
    console.log(`  CONTRACT ADDRESS: ${addressStr} (reused — no deployment transaction was broadcast)`);
  }

  // Independent verification: on-chain state + verifier-key byte-match via attach.
  // This runs for BOTH paths, so a reused address is fully re-validated from
  // chain data rather than trusted.
  const chainState = await adminProviders.publicDataProvider.queryContractState(address);
  const stateFound = chainState !== null && chainState !== undefined;
  if (!stateFound) {
    throw new Error(
      `No on-chain state for ${addressStr}. Refusing to continue: the contract does not exist on Preview ` +
        `(or the address is wrong).`,
    );
  }
  const initialLedger = ledgerOfChainState(chainState);
  console.log(`  on-chain state:   found via indexer`);
  console.log(
    `  on-chain ledger:  surveyOpen=${initialLedger.surveyOpen} participantCount=${initialLedger.participantCount} ` +
      `responseCount=${initialLedger.responseCount} adminAddress=${Buffer.from(initialLedger.adminAddress).toString("hex").slice(0, 16)}…`,
  );
  // A reused contract must be the one THIS admin deployed, otherwise the E2E
  // would exercise a contract whose admin circuit the admin wallet cannot pass.
  const onChainAdmin = Buffer.from(initialLedger.adminAddress).toString("hex");
  if (onChainAdmin !== Buffer.from(adminIdentity).toString("hex")) {
    throw new Error(
      `Contract ${addressStr} on Preview has adminAddress ${onChainAdmin.slice(0, 16)}… which does not match ` +
        `this run's admin identity. It was not deployed by this admin wallet — refusing to continue.`,
    );
  }
  await findContract(adminProviders, adminCompiled, address);
  console.log("  verifier keys:    byte-match confirmed (findDeployedContract attach succeeded)");

  report.deployment = {
    network: NETWORK_ID,
    era: "retained ledger-v8 (compactc 0.31.1 / runtime 0.16.0)",
    address: addressStr,
    reusedExistingContract: REUSE_CONTRACT,
    deployTxId: deployed ? deployed.deployTxData.public.txId : null,
    deployTxHash: deployed ? deployed.deployTxData.public.txHash : null,
    deployStatus: deployed ? deployed.deployTxData.public.status : null,
    deployBlockHeight: deployed ? deployed.deployTxData.public.blockHeight : null,
    stateFoundOnChain: stateFound,
    verifierKeysByteMatched: true,
    adminIdentityOnChain: Buffer.from(initialLedger?.adminAddress ?? new Uint8Array()).toString("hex"),
  };

  const tallyBefore = await readTally(adminProviders, address);
  console.log(`  tally before: ${JSON.stringify(tallyBefore)}`);

  console.log("== Registering 2 participants (real admin transactions) ==");
  const p1 = randomBytes(32);
  const p2 = randomBytes(32);
  const unregisteredSecret = randomBytes(32);
  for (const s of [p1, p2, unregisteredSecret]) rememberSecret(s);

  const adminJoined = await findContract(adminProviders, adminCompiled, address);
  for (const [name, secret] of [
    ["participant-1", p1],
    ["participant-2", p2],
  ]) {
    const leaf = commitmentOf(secret);
    console.log(`  registering ${name}: leaf commitment ${Buffer.from(leaf).toString("hex").slice(0, 16)}… (public)`);
    const finalized = await adminJoined.callTx.registerParticipant(leaf);
    const res = await assertFinalized(adminProviders, finalized.public.txId, `register ${name}`);
    report.transactions.push({ op: `registerParticipant:${name}`, txId: finalized.public.txId, status: res.status, ok: res.ok });
  }
  const tallyAfterRegistration = await readTally(adminProviders, address);
  console.log(`  tally after registration: ${JSON.stringify(tallyAfterRegistration)}`);

  console.log("== Real anonymous submission (participant-1, rating 4) ==");
  const participantProviders = initializeMidnightProviders(participantCore.wallet, envConfig, {
    privateStateStoreName: "feedback-preview-participant",
    zkConfigPath: ARTIFACT_DIR.replace(/\\/g, "/"),
  });
  installSubmissionDiagnostics(participantProviders.walletProvider, participantCore, "participant");

  // The participant pays its transaction fees in DUST too — gate here, right
  // before its first real transaction (its dust scan has been running in the
  // background since wallet start).
  console.log("== Waiting for participant DUST accrual (fees for its transactions) ==");
  participantDust = await waitForDustAccrual(participantCore, "participant");
  const commentText = "great survey, thanks!";
  const commentDigest = new Uint8Array(sha256(Buffer.from(commentText, "utf8")));
  const participantCompiled = await makeCompiled(participantWitnessSet);
  const participantJoined = await participantReady(
    participantProviders,
    participantCompiled,
    address,
    p1,
    4n,
    commentDigest,
  );
  console.log("  composing + proving (real circuit proof via the public Preview proof server)…");
  const submit = await participantJoined.callTx.submitFeedback();
  const submitRes = await assertFinalized(participantProviders, submit.public.txId, "submitFeedback");
  report.transactions.push({ op: "submitFeedback", txId: submit.public.txId, status: submitRes.status, ok: submitRes.ok });

  const tallyAfterSubmit = await readTally(adminProviders, address);
  console.log(`  tally after submission: ${JSON.stringify(tallyAfterSubmit)}`);
  report.transactions.push({
    op: "tally",
    before: tallyBefore,
    afterRegistration: tallyAfterRegistration,
    afterSubmit: tallyAfterSubmit,
  });

  console.log("== Negative tests (real attempts against the deployed contract) ==");
  // Four-way outcome classification (never blurred): a witness/proof failure
  // before submission is NOT an on-chain rejection, and a finalized failure is
  // NOT a construction failure.
  const classify = (outcome) => {
    if (!outcome) return "construction-failure-before-submission";
    const s = outcome.status;
    if (s === "SucceedEntirely") return "successful-finalized-transaction";
    if (typeof s === "string" && s.includes("Fail")) return "finalized-failed-transaction";
    return `finalized-status:${s ?? "unknown"}`;
  };

  const neg = async (name, fn, expect) => {
    try {
      const outcome = await fn();
      const actual = classify(outcome);
      const rejected = actual !== "successful-finalized-transaction";
      const ok = expect === "reject" ? rejected : !rejected;
      report.negativeTests.push({ name, expected: expect, actual, txId: outcome?.txId, pass: ok });
      console.log(`  ${name}: ${actual} (expected ${expect}) -> ${ok ? "PASS" : "FAIL"}`);
    } catch (e) {
      const msg = scrub(e instanceof Error ? e.message : String(e)).slice(0, 200);
      const ok = expect === "reject";
      const actual = `construction-failure-before-submission: ${msg}`;
      report.negativeTests.push({ name, expected: expect, actual, pass: ok });
      console.log(`  ${name}: ${actual} -> ${ok ? "PASS" : "FAIL"}`);
    }
  };

  await neg(
    "unregistered-participant",
    async () => {
      const un = await participantReady(participantProviders, participantCompiled, address, unregisteredSecret, 3n, commentDigest);
      const f = await un.callTx.submitFeedback();
      return { ...f.public, ok: f.public.status === "SucceedEntirely" };
    },
    "reject",
  );

  await neg(
    "invalid-rating-7",
    async () => {
      const un = await participantReady(participantProviders, participantCompiled, address, p2, 7n, commentDigest);
      const f = await un.callTx.submitFeedback();
      return { ...f.public, ok: f.public.status === "SucceedEntirely" };
    },
    "reject",
  );

  await neg(
    "closed-survey",
    async () => {
      const close = await adminJoined.callTx.setSurveyOpen(false);
      const closeRes = await assertFinalized(adminProviders, close.public.txId, "setSurveyOpen(false)");
      report.transactions.push({ op: "setSurveyOpen(false)", txId: close.public.txId, status: closeRes.status, ok: closeRes.ok });

      let submitOutcome;
      try {
        const pJoined = await participantReady(participantProviders, participantCompiled, address, p2, 5n, commentDigest);
        const f = await pJoined.callTx.submitFeedback();
        submitOutcome = { ...f.public, ok: f.public.status === "SucceedEntirely" };
      } finally {
        const reopen = await adminJoined.callTx.setSurveyOpen(true);
        const reopenRes = await assertFinalized(adminProviders, reopen.public.txId, "setSurveyOpen(true)");
        report.transactions.push({ op: "setSurveyOpen(true)", txId: reopen.public.txId, status: reopenRes.status, ok: reopenRes.ok });
      }
      return submitOutcome;
    },
    "reject",
  );

  await neg(
    "duplicate-nullifier",
    async () => {
      const un = await participantReady(participantProviders, participantCompiled, address, p1, 2n, commentDigest);
      const f = await un.callTx.submitFeedback();
      return { ...f.public, ok: f.public.status === "SucceedEntirely" };
    },
    "reject",
  );

  // Unauthorized admin action: the PARTICIPANT wallet attempts an admin-only
  // circuit. The witness set resolves adminSecret to ZERO32 for non-admin
  // handles, so adminIdentityOf(ZERO32) != on-chain adminAddress and the
  // circuit must reject on-chain (or the SDK locally) — never succeed.
  await neg(
    "unauthorized-admin-action",
    async () => {
      const un = await participantReady(participantProviders, participantCompiled, address, p2, 1n, commentDigest);
      const f = await un.callTx.setSurveyOpen(false);
      return { ...f.public, ok: f.public.status === "SucceedEntirely" };
    },
    "reject",
  );

  const tallyFinal = await readTally(adminProviders, address);
  console.log(`  final tally: ${JSON.stringify(tallyFinal)}`);
  report.transactions.push({ op: "final-tally", tally: tallyFinal });

  console.log("\n================ PREVIEW DEPLOYMENT + E2E REPORT (safe metadata only) ================");
  console.log(
    JSON.stringify(
      {
        deployment: report.deployment,
        networkEndpoints: { indexer: INDEXER_HTTP, node: NODE_HTTP, proofServer: PROOF_SERVER, networkId: NETWORK_ID },
        adminCoinAddress: adminCore.coinAddress,
        participantCoinAddress: participantCore.coinAddress,
        adminIdentityPublic: Buffer.from(adminIdentity).toString("hex"),
        adminNight: adminNight.toString(),
        participantNight: participantNight.toString(),
        adminDust: adminDust.toString(),
        participantDust: participantDust.toString(),
        transactions: report.transactions,
        negativeTests: report.negativeTests,
        adminSecretStorage: ADMIN_SECRET_FILE,
        note: "Rating is PUBLIC by design (per-rating tally counters). Secrets never printed: seed, admin secret, participant secrets.",
      },
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ),
  );

  // The report above is evidence, not a verdict. Gate the exit code on it so a
  // run cannot be "green" just because it did not throw: a positive step that
  // did not finalize, or a negative test that was NOT rejected, must fail here.
  //
  // The decision itself lives in scripts/lib-deploy-verdict.mjs so it can be
  // failure-tested offline (tests/deploy-verdict.test.ts) without deploying.
  const problems = evaluateVerdict(report, tallyFinal);

  console.log("\n================ VERDICT ================");
  if (problems.length === 0) {
    console.log("  PASS — every positive step finalized, every negative test was rejected.");
  } else {
    console.error(`  FAIL — ${problems.length} problem(s):`);
    for (const p of problems) console.error(`    - ${p}`);
  }

  await env.shutdown().catch((e) => console.log("shutdown:", scrub(String(e)).slice(0, 200)));
  process.exit(verdictExitCode(problems));
} catch (error) {
  // Include the full cause chain: SDK errors (e.g. SubmissionError) carry the
  // real reason in `.cause`, which is NOT part of stack/message — without
  // this, a submission failure logs only "Transaction submission error".
  const describeChain = (e) => {
    const out = [];
    const seen = new Set();
    let cur = e;
    while (cur && typeof cur === "object" && !seen.has(cur) && out.length < 6) {
      seen.add(cur);
      let text;
      if (cur instanceof Error) text = cur.stack ?? cur.message;
      else {
        try {
          text = JSON.stringify(cur);
        } catch {
          text = String(cur);
        }
      }
      out.push(String(text).slice(0, 1500));
      cur = cur.cause;
    }
    return out.join("\n  caused by: ");
  };
  console.error("\n[FATAL]", scrub(describeChain(error)).slice(0, 4000));
  console.error("\nNo deployment result is reported: nothing has been fabricated. Fix the blocker and re-run.");
  process.exit(1);
}
