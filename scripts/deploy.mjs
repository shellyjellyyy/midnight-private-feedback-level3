#!/usr/bin/env node
/**
 * REAL deployment of the Feedback contract to Midnight Preprod + real
 * end-to-end transaction testing — using only the installed 5.0.0-beta.8 SDK
 * line, the project's full ZK artifacts, and the public Preprod proof server.
 *
 * Everything below runs for real or fails loudly. Nothing is simulated and no
 * result is ever fabricated: if any step cannot complete, the script exits
 * with a [BLOCKER]/[FATAL] report and no success metadata is printed.
 *
 * The Preprod faucet is protected by a Cloudflare Turnstile captcha (verified
 * empirically: automated drip requests are rejected with 403), so funding is a
 * human step. The script is therefore split in two phases over the SAME
 * deterministic seeds:
 *
 *   Phase 1 — `node scripts/deploy.mjs --fund-status`
 *       Builds the real admin + participant wallets from their seeds and
 *       prints their Preprod addresses (plus current NIGHT/DUST balances).
 *       Fund those addresses through the faucet web app by hand.
 *
 *   Phase 2 — `node scripts/deploy.mjs`
 *       Runs the real deployment, verifies it through the indexer, registers
 *       participants with real admin transactions, performs a real anonymous
 *       submission from the participant wallet, and runs the negative cases.
 *       Every wallet is checked for NIGHT + DUST first; an unfunded wallet is
 *       a loud blocker, never a simulated success.
 *
 * Secrets policy (enforced, not aspirational):
 *   - MIDNIGHT_PREPROD_SEED is read from the environment ONLY. It is never
 *     written to disk, logs, or the report.
 *   - The participant seed is generated once and stored only in the
 *     gitignored .participant-seed file so Phase 2 controls the same wallet.
 *   - The admin secret is generated with crypto.randomBytes, hashed into the
 *     constructor (only the hash goes on-chain), and stored only in the
 *     gitignored file MIDNIGHT_ADMIN_SECRET_FILE (default .admin-secret).
 *     Losing that file loses admin authority — by design, documented.
 *   - A redacting logger wraps every SDK log line so no secret can reach the
 *     console even if the SDK itself tries to print one.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { resolve } from "node:path";
import process from "node:process";

// ---------------------------------------------------------------------------
// 0. Fail loudly, early, on missing configuration.
// ---------------------------------------------------------------------------

const FUND_STATUS_MODE =
  process.argv.includes("--fund-status") || process.env.MIDNIGHT_FUND_STATUS === "1";

const SEED = process.env.MIDNIGHT_PREPROD_SEED?.trim();
if (!SEED) {
  console.error(
    "\n[BLOCKER] MIDNIGHT_PREPROD_SEED is not set.\n" +
      "  Generate a fresh seed locally (never commit it):\n" +
      "    node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"\n" +
      "  then re-run:\n" +
      "    MIDNIGHT_PREPROD_SEED=<seed> node scripts/deploy.mjs --fund-status   # phase 1: addresses\n" +
      "    MIDNIGHT_PREPROD_SEED=<seed> node scripts/deploy.mjs                 # phase 2: deploy + E2E\n",
  );
  process.exit(2);
}

const ADMIN_SECRET_FILE = process.env.MIDNIGHT_ADMIN_SECRET_FILE ?? ".admin-secret";
const PARTICIPANT_SEED_FILE = ".participant-seed";
const FUND_TIMEOUT_SECS = Number(process.env.MIDNIGHT_FUND_TIMEOUT_SECS ?? "900");
const NETWORK_ID = "preprod";

const INDEXER_HTTP = "https://indexer.preprod.midnight.network/api/v4/graphql";
const INDEXER_WS = "wss://indexer.preprod.midnight.network/api/v4/graphql/ws";
const NODE_HTTP = "https://rpc.preprod.midnight.network";
const NODE_WS = "wss://rpc.preprod.midnight.network";
const PROOF_SERVER = process.env.MIDNIGHT_PROOF_SERVER ?? "https://proof-server.preprod.midnight.network";
const FAUCET_WEB = "https://faucet.preprod.midnight.network";
const FAUCET_API = "https://faucet.preprod.midnight.network/api/drips";

// ---------------------------------------------------------------------------
// 1. Redacting logger — every SDK log line passes through scrub().
// ---------------------------------------------------------------------------

const SECRETS = new Set();
const rememberSecret = (value) => {
  if (typeof value === "string" && value.length >= 32) SECRETS.add(value);
  if (value instanceof Uint8Array) {
    SECRETS.add(Buffer.from(value).toString("hex"));
    SECRETS.add(Buffer.from(value).toString("base64"));
  }
};
const scrub = (text) => {
  let out = String(text);
  for (const s of SECRETS) {
    if (s && out.includes(s)) out = out.split(s).join("[REDACTED]");
  }
  return out;
};
const makeRedactingLogger = () => {
  const emit = (level) => (payload, msg) => {
    const line = typeof payload === "string" ? payload : (msg ?? "");
    if (level === "debug" || level === "trace") return;
    console.log(`[${level}]`, scrub(line).slice(0, 1200));
  };
  const logger = {
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    debug: () => {},
    trace: () => {},
    fatal: emit("fatal"),
    child: () => logger,
    level: "info",
  };
  return logger;
};
const logger = makeRedactingLogger();

// ---------------------------------------------------------------------------
// 2. Managed contract bindings + pure helpers (runtime's own persistentHash).
// ---------------------------------------------------------------------------

const managedMod = await import("../managed/feedback/contract/index.js");
const compactRuntime = await import("@midnight-ntwrk/compact-runtime");

const bytes32 = new compactRuntime.CompactTypeBytes(32);
const vector2 = new compactRuntime.CompactTypeVector(2, bytes32);
const tagPad = (text) => {
  const out = new Uint8Array(32);
  out.set(Buffer.from(text, "ascii").subarray(0, 32));
  return out;
};
const TAG_ADMIN_IDENTITY = tagPad("midnight:feedback:admin:identity");
const TAG_COMMITMENT = tagPad("midnight:feedback:commitment");
const taggedHash2 = (tag, value) => compactRuntime.persistentHash(vector2, [tag, value]);
const adminIdentityOf = (secret) => taggedHash2(TAG_ADMIN_IDENTITY, secret);
const commitmentOf = (secret) => taggedHash2(TAG_COMMITMENT, secret);
const ZERO32 = new Uint8Array(32);
const sha256 = (buf) => createHash("sha256").update(buf).digest();
const ledgerOfChainState = (chainState) =>
  managedMod.ledger(
    chainState && chainState.data !== undefined && !(chainState instanceof compactRuntime.StateValue)
      ? chainState.data
      : chainState,
  );

// ---------------------------------------------------------------------------
// 3. Preflight — verify every external prerequisite empirically.
// ---------------------------------------------------------------------------

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

  // Chain era: the v9 fork activates at protocolVersion 2000000
  // (wallet-sdk DefaultForkSchedule {v9: "2000000"}). This project's contract
  // is v9-native (compact 0.34.0 artifacts; pragma language_version >= 0.23),
  // so deployment is only possible once the chain reports >= 2000000.
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
    console.log(`  chain tip:    height=${chainTip.height} protocolVersion=${chainTip.protocolVersion} (v9 fork at 2000000)`);
  } else {
    console.log("  chain tip:    UNAVAILABLE (could not read block info from the indexer)");
  }

  const zkDir = resolve("managed/feedback");
  const manifestPath = resolve(zkDir, "compiler/contract-manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error("managed/feedback ZK artifacts missing — run the full compact compile first");
  }
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(zkDir);
  console.log(`  ZK artifacts: ${files.length} files on disk (integrity enforced by the provider at use time)`);

  const failed = [gql, rpc, proof].filter((s) => s.startsWith("FAILED"));
  if (failed.length > 0) {
    console.error("\n[BLOCKER] Preprod prerequisites failed preflight:", failed);
    process.exit(3);
  }
  return { chainTip };
}

// ---------------------------------------------------------------------------
// 4. Environment + wallets (real Node wallets from the testkit).
// ---------------------------------------------------------------------------

const testkit = await import("@midnight-ntwrk/testkit-js");

function buildEnvConfig() {
  // A StaticProofServerContainer-shaped object pointing at the PUBLIC Preprod
  // proof server — no Docker needed. We assign the field directly and build
  // the configuration ourselves (skipping start(), whose node/indexer health
  // probes use GET endpoints this node answers with 405/404).
  const env = new testkit.PreprodTestEnvironment(logger);
  env.proofServerContainer = {
    getUrl: () => PROOF_SERVER,
    stop: async () => {},
  };
  const envConfig = env.getEnvironmentConfiguration();
  console.log("  environment configuration ready (indexer/node/proof-server reachable)");
  return { env, envConfig };
}

/** Builds + starts a real Node wallet from a seed. No funding logic. */
async function startWalletCore(envConfig, seed, label) {
  console.log(`  building ${label} wallet (seed redacted)…`);
  const wallet = await testkit.MidnightWalletProvider.build(logger, envConfig, seed);
  await wallet.start(false); // no SDK faucet attempt; funding is explicit below
  const adapter = new testkit.DAppConnectorWalletAdapter(wallet, envConfig);
  const { unshieldedAddress } = await adapter.getUnshieldedAddress();
  console.log(`  ${label} wallet ready: ${unshieldedAddress}`);
  return { wallet, adapter, unshieldedAddress };
}

/**
 * Bounded sync: the facade exposes waitForSyncedState() (testkit's syncWallet
 * helper targets a state() method this wallet build does not expose). Raced
 * with a timeout so an unfunded/empty wallet cannot stall the run forever.
 */
async function boundedSync(wallet, ms) {
  const timeoutMs = ms ?? 180000;
  try {
    await Promise.race([
      wallet.wallet.waitForSyncedState(),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`sync timeout after ${timeoutMs}ms`)), timeoutMs)),
    ]);
    return true;
  } catch (e) {
    console.log(`  sync: ${scrub(e instanceof Error ? e.message : String(e)).slice(0, 120)}`);
    return false;
  }
}

function readBalances(adapter) {
  return Promise.all([adapter.getUnshieldedBalances(), adapter.getDustBalance()]).then(
    ([unshieldedBalances, dust]) => ({
      night: Object.values(unshieldedBalances).reduce((a, b) => a + b, 0n),
      dust: dust.balance,
      dustCap: dust.cap,
    }),
  );
}

/**
 * Waits until the wallet has NIGHT and DUST, requesting faucet drips along the
 * way (the faucet rejects automated requests with 403 — captcha — so in
 * practice the human funds the address printed by --fund-status). Unfunded is
 * a loud blocker, never a simulated success.
 */
async function ensureFunded(env, envConfig, core, label) {
  const { wallet, adapter, unshieldedAddress } = core;
  const deadline = Date.now() + FUND_TIMEOUT_SECS * 1000;
  let balances = await readBalances(adapter);
  for (;;) {
    if (balances.night > 0n && balances.dust > 0n) break;
    if (Date.now() > deadline) {
      console.error(
        `\n[BLOCKER] ${label} wallet is not funded after ${FUND_TIMEOUT_SECS}s ` +
          `(NIGHT=${balances.night}, DUST=${balances.dust}).\n` +
          `  The Preprod faucet requires a browser captcha (verified: automated drips get HTTP 403).\n` +
          `  Fund this Preprod address manually at ${FAUCET_WEB} , then re-run this script:\n` +
          `  ${label} address: ${unshieldedAddress}\n`,
      );
      await env.shutdown().catch(() => {});
      process.exit(4);
    }
    console.log(`  ${label}: NIGHT=${balances.night} DUST=${balances.dust} — requesting a faucet drip…`);
    try {
      const { FaucetClient } = await import("@midnight-ntwrk/testkit-js");
      await new FaucetClient(FAUCET_API, logger).requestTokens(unshieldedAddress);
    } catch (e) {
      const status = e?.response?.status;
      console.log(
        `  faucet request ${status ? `rejected (HTTP ${status})` : `failed: ${scrub(e.message).slice(0, 120)}`}`,
      );
    }
    await new Promise((r) => setTimeout(r, 30000));
    await boundedSync(wallet, 120000);
    balances = await readBalances(adapter);
  }
  console.log(`  ${label} funded: NIGHT=${balances.night} DUST=${balances.dust} (cap ${balances.dustCap})`);
  return balances;
}

// ---------------------------------------------------------------------------
// 5. Compiled contract instances.
// ---------------------------------------------------------------------------

async function makeCompiled(witnessSet) {
  const { CompiledContract } = await import("@midnight-ntwrk/compact-js");
  return CompiledContract.make("Feedback", managedMod.Contract).pipe(
    CompiledContract.withWitnesses(witnessSet),
    CompiledContract.withCompiledFileAssets("./managed/feedback"),
  );
}

let adminRuntimeSecret = ZERO32; // set in main before any proving happens

// The admin set: the admin witness closes over the real admin secret; every
// other witness is inert (admin circuits never touch respondent material).
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

// The participant set is exactly what the browser runs: zero admin material.
const participantWitnessSet = {
  participantSecret: (ctx) => [ctx.privateState, ctx.privateState.secret],
  participantMerklePath: (ctx, leaf) => {
    const path = ctx.ledger.participants.findPathForLeaf(leaf);
    if (path === undefined) {
      throw new Error("This secret is not registered for this survey.");
    }
    return [ctx.privateState, path];
  },
  feedbackRating: (ctx) => [ctx.privateState, ctx.privateState.rating],
  feedbackComment: (ctx) => [ctx.privateState, ctx.privateState.commentDigest],
  adminSecret: (ctx) => [ctx.privateState, ZERO32],
};

// ---------------------------------------------------------------------------
// 6. Small helpers over the real providers.
// ---------------------------------------------------------------------------

const FEEDBACK_PRIVATE_STATE_ID = "feedbackPrivateState";

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

async function waitForTx(providers, txId) {
  const record = await providers.publicDataProvider.watchForTxData(txId);
  const meta = record;
  return {
    status: meta.status ?? "unknown",
    segmentStatusMap: meta.tx?.segmentStatusMap,
  };
}

async function assertFinalized(providers, txId, what) {
  const { status, segmentStatusMap } = await waitForTx(providers, txId);
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

async function findContract(providers, compiled, address) {
  const { findDeployedContract } = await import("@midnight-ntwrk/midnight-js-contracts");
  return findDeployedContract(providers, {
    compiledContract: compiled,
    contractAddress: address,
    privateStateId: FEEDBACK_PRIVATE_STATE_ID,
  });
}

/** Participant private state + a fresh join for one submission attempt. */
async function participantReady(participantProviders, participantCompiled, address, secret, rating, commentDigest) {
  await participantProviders.privateStateProvider.set(FEEDBACK_PRIVATE_STATE_ID, {
    secret,
    commentDigest,
    rating: BigInt(rating),
  });
  return findContract(participantProviders, participantCompiled, address);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const report = {
  deployment: null,
  transactions: [],
  negativeTests: [],
};

const V9_FORK_PROTOCOL_VERSION = 2000000n;
function eraWarning(chainTip) {
  if (!chainTip || BigInt(chainTip.protocolVersion) >= V9_FORK_PROTOCOL_VERSION) return null;
  return (
    `[ERA] Preprod chain: protocolVersion ${chainTip.protocolVersion} at height ${chainTip.height} is BELOW the ` +
    `ledger-v9 fork threshold (2000000). The chain still runs ledger-v8.`
  );
}

try {
  const { chainTip } = await preflight();
  rememberSecret(SEED);

  console.log("== Environment ==");
  const { env, envConfig } = buildEnvConfig();

  // ---- Participant seed: deterministic across phases, gitignored, redacted.
  let seed2 = process.env.MIDNIGHT_PARTICIPANT_SEED?.trim();
  let seed2Origin = "from MIDNIGHT_PARTICIPANT_SEED";
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

  console.log("== Admin wallet (from MIDNIGHT_PREPROD_SEED) ==");
  const adminCore = await startWalletCore(envConfig, SEED, "admin");
  console.log("== Participant wallet ==");
  console.log(`  participant seed ${seed2Origin}`);
  const participantCore = await startWalletCore(envConfig, seed2, "participant");

  // ---------------- Phase 1: fund-status — print addresses and exit. --------
  if (FUND_STATUS_MODE) {
    const era = eraWarning(chainTip);
    if (era) {
      console.log(`\n  WARNING: ${era}\n  Deployment (phase 2) will refuse to run until the v9 fork is enacted on Preprod.`);
    }
    // Balances are only meaningful after the wallet has synced the chain.
    console.log("  syncing wallets (bounded)…");
    await boundedSync(adminCore.wallet);
    await boundedSync(participantCore.wallet);
    const adminBalances = await readBalances(adminCore.adapter);
    const participantBalances = await readBalances(participantCore.adapter);
    console.log("\n================ FUNDING STATUS (phase 1) ================");
    console.log(`network:            ${NETWORK_ID}`);
    console.log(`admin address:      ${adminCore.unshieldedAddress}`);
    console.log(`admin NIGHT/DUST:   ${adminBalances.night} / ${adminBalances.dust}`);
    console.log(`participant addr:   ${participantCore.unshieldedAddress}`);
    console.log(`participant N/D:    ${participantBalances.night} / ${participantBalances.dust}`);
    console.log(`faucet (human):     ${FAUCET_WEB}  (captcha-protected; automated drips are rejected)`);
    console.log("next: fund both addresses, then run phase 2: node scripts/deploy.mjs");
    await env.shutdown().catch(() => {});
    process.exit(0);
  }

  // ---------------- Phase 2: real deployment + E2E. ------------------------
  // HARD ERA GATE — verified against the live chain, not assumed:
  // protocolVersion >= 2000000 means ledger-v9 is active and this project's
  // v9-native contract (compact 0.34.0) can be deployed. Below it, the chain
  // rejects v9 deployment transactions; deploying would require recompiling
  // for the retained v8 toolchain (compact 0.30.0, language 0.22.0), which
  // this contract's source (pragma >= 0.23) forbids.
  const era = eraWarning(chainTip);
  if (era) {
    console.error(
      `\n[BLOCKER] ${era}\n` +
        `  This project's contract is v9-native (compact 0.34.0 / compact-runtime 0.19.0; pragma language_version >= 0.23) ` +
        `and cannot be deployed to a pre-fork (ledger-v8) chain, nor recompiled for the v8 toolchain without changing ` +
        `the contract source.\n` +
        `  No deployment was attempted; nothing has been fabricated. Re-run after Midnight enacts the v9 fork on Preprod ` +
        `(watch protocolVersion via this script's preflight or scripts/validate-subscriptions.mjs).\n`,
    );
    await env.shutdown().catch(() => {});
    process.exit(6);
  }

  console.log("== Funding check ==");
  const adminBalances = await ensureFunded(env, envConfig, adminCore, "admin");
  const participantBalances = await ensureFunded(env, envConfig, participantCore, "participant");

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

  console.log("== Deploying Feedback to Preprod ==");
  const adminCompiled = await makeCompiled(adminWitnessSet);
  const { deployContract } = await import("@midnight-ntwrk/midnight-js-contracts");
  const { initializeMidnightProviders } = testkit;

  const adminProviders = initializeMidnightProviders(adminCore.wallet, envConfig, {
    privateStateStoreName: "feedback-deploy-admin",
    zkConfigPath: resolve("managed/feedback"),
  });
  await adminProviders.privateStateProvider.set(FEEDBACK_PRIVATE_STATE_ID, {
    secret: ZERO32,
    commentDigest: ZERO32,
    rating: 0n,
  });

  console.log("  composing + proving the deployment transaction (real proving, may take a while)…");
  const deployed = await deployContract(adminProviders, {
    compiledContract: adminCompiled,
    args: [adminIdentity],
    privateStateId: FEEDBACK_PRIVATE_STATE_ID,
    initialPrivateState: { secret: ZERO32, commentDigest: ZERO32, rating: 0n },
  });

  const address = deployed.deployTxData.public.contractAddress;
  const addressStr = String(address);
  const deployTxId = deployed.deployTxData.public.txId;
  const deployStatus = deployed.deployTxData.public.status;
  console.log(`  CONTRACT ADDRESS: ${addressStr}`);
  console.log(`  deploy txId:      ${deployTxId}`);
  console.log(`  deploy status:    ${deployStatus}`);

  // Independent verification: the state exists on-chain, and
  // findDeployedContract re-attaches — which byte-matches the LOCAL verifier
  // keys against the DEPLOYED keys and throws on any mismatch.
  const chainState = await adminProviders.publicDataProvider.queryContractState(address);
  const stateFound = chainState !== null && chainState !== undefined;
  const initialLedger = stateFound ? ledgerOfChainState(chainState) : null;
  console.log(`  on-chain state:   ${stateFound ? "found via indexer" : "NOT FOUND"}`);
  if (initialLedger) {
    console.log(
      `  initial ledger:   surveyOpen=${initialLedger.surveyOpen} adminAddress=${Buffer.from(initialLedger.adminAddress).toString("hex").slice(0, 16)}…`,
    );
  }
  await findContract(adminProviders, adminCompiled, address);
  console.log("  verifier keys:    byte-match confirmed (findDeployedContract attach succeeded)");

  report.deployment = {
    network: NETWORK_ID,
    address: addressStr,
    deployTxId,
    deployStatus,
    stateFoundOnChain: stateFound,
    verifierKeysByteMatched: true,
    adminIdentityOnChain: Buffer.from(initialLedger?.adminAddress ?? new Uint8Array()).toString("hex"),
  };

  const tallyBefore = await readTally(adminProviders, address);
  console.log(`  tally before: ${JSON.stringify(tallyBefore)}`);

  // ---------------- Registration (real admin transactions) ----------------
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

  // ---------------- Real anonymous submission from the participant wallet --
  const participantProviders = initializeMidnightProviders(participantCore.wallet, envConfig, {
    privateStateStoreName: "feedback-deploy-participant",
    zkConfigPath: resolve("managed/feedback"),
  });
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

  console.log("== Real anonymous submission (participant-1, rating 4) ==");
  console.log("  composing + proving (real circuit proof via the public proof server)…");
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

  // ---------------- Negative tests ----------------
  console.log("== Negative tests (real attempts against the deployed contract) ==");

  const neg = async (name, fn, expect) => {
    try {
      const outcome = await fn();
      const actual = outcome?.status ?? "local-rejection";
      const rejected = !outcome?.ok || actual !== "SucceedEntirely";
      const ok = expect === "reject" ? rejected : actual === "SucceedEntirely";
      report.negativeTests.push({ name, expected: expect, actual, txId: outcome?.txId, pass: ok });
      console.log(`  ${name}: ${actual} (expected ${expect}) -> ${ok ? "PASS" : "FAIL"}`);
    } catch (e) {
      const msg = scrub(e instanceof Error ? e.message : String(e)).slice(0, 200);
      const ok = expect === "reject";
      report.negativeTests.push({ name, expected: expect, actual: `error: ${msg}`, pass: ok });
      console.log(`  ${name}: rejected before submission (${msg}) -> ${ok ? "PASS" : "FAIL"}`);
    }
  };

  // (a) Unregistered participant — witness fails closed before any tx exists.
  await neg(
    "unregistered-participant",
    async () => {
      const un = await participantReady(participantProviders, participantCompiled, address, unregisteredSecret, 3n, commentDigest);
      const f = await un.callTx.submitFeedback();
      return { ...f.public, ok: f.public.status === "SucceedEntirely" };
    },
    "reject",
  );

  // (b) Invalid rating (7) — the circuit's bounds assert must reject on-chain.
  await neg(
    "invalid-rating-7",
    async () => {
      const un = await participantReady(participantProviders, participantCompiled, address, p2, 7n, commentDigest);
      const f = await un.callTx.submitFeedback();
      return { ...f.public, ok: f.public.status === "SucceedEntirely" };
    },
    "reject",
  );

  // (c) Closed survey — admin closes; submission must be rejected; reopen.
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

  // (d) Duplicate submission — same secret (p1) again; nullifier assert fires.
  await neg(
    "duplicate-nullifier",
    async () => {
      const un = await participantReady(participantProviders, participantCompiled, address, p1, 2n, commentDigest);
      const f = await un.callTx.submitFeedback();
      return { ...f.public, ok: f.public.status === "SucceedEntirely" };
    },
    "reject",
  );

  const tallyFinal = await readTally(adminProviders, address);
  console.log(`  final tally: ${JSON.stringify(tallyFinal)}`);
  report.transactions.push({ op: "final-tally", tally: tallyFinal });

  // ---------------- Report (safe metadata only) ----------------
  console.log("\n================ DEPLOYMENT + E2E REPORT (safe metadata only) ================");
  console.log(
    JSON.stringify(
      {
        deployment: report.deployment,
        networkEndpoints: { indexer: INDEXER_HTTP, node: NODE_HTTP, proofServer: PROOF_SERVER, networkId: NETWORK_ID },
        adminUnshieldedAddress: adminCore.unshieldedAddress,
        participantUnshieldedAddress: participantCore.unshieldedAddress,
        adminIdentityPublic: Buffer.from(adminIdentity).toString("hex"),
        adminBalances: { night: adminBalances.night.toString(), dust: adminBalances.dust.toString() },
        transactions: report.transactions,
        negativeTests: report.negativeTests,
        adminSecretStorage: ADMIN_SECRET_FILE,
        note: "Rating is PUBLIC by design (per-rating tally counters). Secrets never printed: seed, admin secret, participant secrets.",
      },
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ),
  );

  await env.shutdown().catch((e) => console.log("shutdown:", scrub(String(e)).slice(0, 200)));
  process.exit(0);
} catch (error) {
  console.error("\n[FATAL]", scrub(error instanceof Error ? (error.stack ?? error.message) : String(error)).slice(0, 4000));
  console.error("\nNo deployment result is reported: nothing has been fabricated. Fix the blocker and re-run.");
  process.exit(1);
}
