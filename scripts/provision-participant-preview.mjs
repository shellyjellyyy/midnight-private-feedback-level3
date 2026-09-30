#!/usr/bin/env node
// MEMORY: a full chain sync needs a bigger V8 heap than the default. Run with:
//   node --max-old-space-size=8192 scripts/provision-participant-preview.mjs
/**
 * ORGANIZER-SIDE PROVISIONING for the live Preview survey contract.
 *
 * The feedback contract deliberately requires an organizer to register
 * `commitment(secret)` in the public `participants` Merkle tree before any
 * respondent holding that secret can submit. This script is that missing half:
 * it mints (or accepts) a respondent's invite secret, derives the exact
 * commitment the contract derives, and registers it through the real
 * admin-authorized `registerParticipant` circuit.
 *
 * It registers against an ALREADY-DEPLOYED contract. It never deploys, never
 * redeploys, and never modifies contract code:
 *
 *   Default contract: the live Preview address below.
 *   Override:        --contract <32-byte-hex>
 *
 * Usage
 *   # Generate a fresh secret, register it, write it to a gitignored file.
 *   node --max-old-space-size=8192 scripts/provision-participant-preview.mjs
 *
 *   # Register a secret YOU generated, supplied out-of-band (recommended — the
 *   # same file is then pasted straight into the browser's import field).
 *   node --max-old-space-size=8192 scripts/provision-participant-preview.mjs \
 *     --secret-file .my-respondent-secret
 *
 *   # Print the secret to stdout as well (only when you need to transfer it).
 *   node ... scripts/provision-participant-preview.mjs --print-secret
 *
 * Required node_modules patch (unchanged from the deploy path):
 *   node scripts/patch-dust-empty-actions.mjs
 * The admin wallet pays fees in DUST; without the patch every contract call is
 * rejected by the Preview mempool with "Custom error: 117" (NotNormalized).
 *
 * SECRETS POLICY (enforced, not aspirational)
 *   - The ADMIN seed is read from the environment or the gitignored
 *     .admin-seed-preview, exactly as scripts/deploy-preview.mjs does.
 *   - The ADMIN secret lives only in the gitignored .admin-secret-preview.
 *   - The RESPONDENT secret is written ONLY to a gitignored file (default
 *     .respondent-secret-preview) or to stdout when --print-secret is given.
 *     It is never written into source, never committed, never placed in a URL
 *     or a diagnostic record, and is scrubbed from every SDK log line.
 *   - Only PUBLIC values are printed by default: the leaf commitment (which is
 *     on-chain by design) and the registration tx id / status.
 *
 * Everything runs for real or fails loudly. No result is ever fabricated.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { rememberSecret, scrub, makeRedactingLogger } from "./lib-redacting-logger.mjs";
import {
  loadLedger8,
  participantCommitmentOf,
  parseSecretHex,
  secretToHex,
} from "./lib-participant-commitment.mjs";

// ---------------------------------------------------------------------------
// 0. Configuration, fail-loudly.
// ---------------------------------------------------------------------------

// The live Preview deployment (retained ledger-v8 era), verified 2026-09-30.
// Provisioning targets this contract; it is never redeployed.
const DEFAULT_CONTRACT =
  "916ae63acf5d4256a33c249cf138938cb9cb33210cf6081feecb2a18648248bc";

const CONTRACT_ADDRESS = (() => {
  const i = process.argv.indexOf("--contract");
  const raw = (
    i >= 0 && process.argv[i + 1] ? process.argv[i + 1].trim() : process.env.MIDNIGHT_PREVIEW_CONTRACT ?? DEFAULT_CONTRACT
  )
    .replace(/^0x/, "")
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(raw)) {
    console.error(`[BLOCKER] --contract expects a 32-byte hex contract address, got: ${raw}`);
    process.exit(2);
  }
  return raw;
})();

const PRINT_SECRET = process.argv.includes("--print-secret");

// The respondent secret may arrive three ways, in priority order:
//   --secret-file <path>   a local file holding the 64-char hex (out-of-band)
//   --secret <hex>         discouraged: leaks via the process list / shell history
//   (none)                 generate a fresh one and persist it
const RESPONDENT_SECRET_FILE = process.env.MIDNIGHT_RESPONDENT_SECRET_FILE_PREVIEW ?? ".respondent-secret-preview";

function resolveRespondentSecret() {
  const fileIdx = process.argv.indexOf("--secret-file");
  if (fileIdx >= 0) {
    const path = process.argv[fileIdx + 1];
    if (!path) {
      console.error("[BLOCKER] --secret-file expects a path.");
      process.exit(2);
    }
    if (!existsSync(path)) {
      console.error(`[BLOCKER] --secret-file ${path} does not exist.`);
      process.exit(2);
    }
    return { secret: parseSecretHex(readFileSync(path, "utf8")), origin: `read from ${path}`, path };
  }

  const inlineIdx = process.argv.indexOf("--secret");
  if (inlineIdx >= 0) {
    const hex = process.argv[inlineIdx + 1];
    if (!hex) {
      console.error("[BLOCKER] --secret expects a 64-char hex value.");
      process.exit(2);
    }
    console.warn(
      "[WARN] --secret puts the secret in your shell history and process list. " +
        "Prefer --secret-file <path>.",
    );
    return { secret: parseSecretHex(hex), origin: "read from --secret", path: RESPONDENT_SECRET_FILE };
  }

  const secret = new Uint8Array(randomBytes(32));
  return { secret, origin: "freshly generated", path: RESPONDENT_SECRET_FILE };
}

const ADMIN_SEED_FILE = ".admin-seed-preview";
const SEED = process.env.MIDNIGHT_PREVIEW_SEED?.trim() ||
  (existsSync(ADMIN_SEED_FILE) ? readFileSync(ADMIN_SEED_FILE, "utf8").trim() : undefined);
if (!SEED) {
  console.error(
    "\n[BLOCKER] No admin seed available for Preview.\n" +
      "  Set MIDNIGHT_PREVIEW_SEED, or create the gitignored file (never commit it):\n" +
      "    node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" > .admin-seed-preview\n" +
      "  This must be the SAME admin that deployed the survey contract, or the\n" +
      "  registerParticipant circuit will reject the call.\n",
  );
  process.exit(2);
}

const ADMIN_SECRET_FILE = process.env.MIDNIGHT_ADMIN_SECRET_FILE_PREVIEW ?? ".admin-secret-preview";
const NETWORK_ID = "preview";
const ARTIFACT_DIR = resolve("managed/feedback-v8");
const PROOF_SERVER = process.env.MIDNIGHT_PROOF_SERVER_PREVIEW ?? "https://proof-server.preview.midnight.network";

// NOTE: there is deliberately NO FEEDBACK_PRIVATE_STATE_ID here. This script
// only ever makes an admin call (`registerParticipant`), which takes no private
// state. See findContract() below for why attaching with that id fails.

const logger = makeRedactingLogger();

// The stable (v8-era) contracts module, loaded by explicit path so it cannot
// dual-resolve to the hoisted v9 copy. Same resolution as deploy-preview.mjs.
const STABLE_CONTRACTS_ESM = resolve(
  "node_modules/@midnight-ntwrk/testkit-js-stable/node_modules/@midnight-ntwrk/midnight-js-contracts/dist/index.mjs",
);

// ---------------------------------------------------------------------------
// 1. v8-era toolchain (stable line only — never the beta.8 stack).
// ---------------------------------------------------------------------------

const testkit = await import("@midnight-ntwrk/testkit-js-stable");
const ledger8 = await loadLedger8();

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

// Plain module state nothing else sets for us: the testkit only configures it
// inside its own getTestEnvironment() switch, which we bypass.
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

// Token-type equality is module-instance-bound, so the NIGHT raw token used to
// filter UTXOs must come from the SAME ledger module the testkit's wallet stack
// resolves.
const protocolLedgerUrl = createRequire(
  resolve("node_modules/@midnight-ntwrk/testkit-js-stable/package.json"),
).resolve("@midnight-ntwrk/midnight-js-protocol/ledger");
const protocolLedgerMod = await import(pathToFileURL(protocolLedgerUrl).href);
const protocolLedger = protocolLedgerMod.default ?? protocolLedgerMod;

// Fail before any chain sync if the required patch is missing.
const DUST_WALLET_TRANSACTING = "node_modules/@midnight-ntwrk/wallet-sdk-dust-wallet/dist/v1/Transacting.js";
if (!readFileSync(DUST_WALLET_TRANSACTING, "utf8").includes("patch-dust-empty-actions.mjs")) {
  throw new Error(
    "Required patch is not applied to " +
      DUST_WALLET_TRANSACTING +
      ".\n  Run:  node scripts/patch-dust-empty-actions.mjs\n" +
      "  Without it every contract call is rejected with ledger error 117 (NotNormalized).",
  );
}

// The CompiledContract builder MUST come from the testkit's nested compact-js.
function loadStableCompactJs() {
  const testkitEntry = createRequire(import.meta.url).resolve("@midnight-ntwrk/testkit-js-stable");
  const reqFromTestkit = createRequire(testkitEntry);
  const nestedPkgJson = reqFromTestkit.resolve("@midnight-ntwrk/compact-js/package.json");
  const esmEntry = resolve(nestedPkgJson, "..", "dist", "esm", "index.js");
  if (!existsSync(esmEntry)) throw new Error(`stable compact-js ESM entry not found at ${esmEntry}`);
  return import(pathToFileURL(esmEntry).href);
}
const { CompiledContract } = await loadStableCompactJs();

// ---------------------------------------------------------------------------
// 2. Ledger helpers (same construction as deploy-preview.mjs).
// ---------------------------------------------------------------------------

const ZERO32 = new Uint8Array(32);
const bytes32 = new ledger8.CompactTypeBytes(32);
const vector2 = new ledger8.CompactTypeVector(2, bytes32);
const tagPad = (text) => {
  const out = new Uint8Array(32);
  out.set(Buffer.from(text, "ascii").subarray(0, 32));
  return out;
};
const TAG_ADMIN_IDENTITY = tagPad("midnight:feedback:admin:identity");
const adminIdentityOf = (secret) => ledger8.persistentHash(vector2, [TAG_ADMIN_IDENTITY, secret]);

const ledgerOfChainState = (chainState) =>
  managedMod.ledger(
    chainState && chainState.data !== undefined && !(chainState instanceof ledger8.StateValue)
      ? chainState.data
      : chainState,
  );

/**
 * The ADMIN witness set. Only `adminSecret` is real; the respondent-facing
 * witnesses are never reached by `registerParticipant`, but the generated
 * contract requires all five to be present.
 */
let adminRuntimeSecret = ZERO32;
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

async function makeCompiled() {
  return CompiledContract.make("Feedback", managedMod.Contract).pipe(
    CompiledContract.withWitnesses(adminWitnessSet),
    CompiledContract.withCompiledFileAssets(ARTIFACT_DIR.replace(/\\/g, "/")),
  );
}

// ---------------------------------------------------------------------------
// 3. Wallet / provider setup (real Node wallet from the stable testkit).
// ---------------------------------------------------------------------------

function buildEnvConfig() {
  const env = new testkit.PreviewTestEnvironment(logger);
  env.proofServerContainer = { getUrl: () => PROOF_SERVER, stop: async () => {} };
  return env.getEnvironmentConfiguration();
}

async function startAdminWallet(envConfig, seed) {
  const wallet = await testkit.MidnightWalletProvider.build(logger, envConfig, seed);
  await wallet.start(false);
  const shieldedState = await testkit.getInitialShieldedState(wallet.wallet.shielded);
  return { wallet, coinAddress: shieldedState.address.coinPublicKeyString() };
}

function balanceOfDust(state) {
  return state.dust?.balance ?? 0n;
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
    `  ${what}: txId=${txId} status=${status}` +
      (failedSegments.length > 0 ? ` failedSegments=${failedSegments.map(([id]) => id).join(",")}` : ""),
  );
  if (!ok) {
    throw new Error(`registration transaction did not succeed entirely: status=${status}`);
  }
  return { ok, status, txId };
}

/**
 * Attaches to the deployed contract for an ADMIN-ONLY call.
 *
 * NO `privateStateId` HERE, DELIBERATELY.
 *   `registerParticipant`'s only witness is `adminSecret`, which this script
 *   supplies from the `adminRuntimeSecret` closure. It reads nothing from the
 *   private state, so there is no private state to load or seed.
 *
 *   `findDeployedContract` has four documented private-state branches (stable
 *   midnight-js-contracts, setOrGetInitialPrivateState):
 *     - id + initialState  -> store it
 *     - id, no state, entry exists -> use the stored entry
 *     - id, no state, NO entry -> assertDefined THROWS
 *     - no id, no state      -> returns undefined, nothing stored
 *   Passing `privateStateId` without `initialPrivateState` lands in the third
 *   branch, which failed live with
 *     "No private state found at private state ID 'feedbackPrivateState'"
 *   because this script deliberately uses its own store
 *   ("feedback-preview-provisioner"), which starts empty.
 *
 *   Omitting the key takes the fourth branch and is what
 *   scripts/deploy-preview.mjs's own comment prescribes for admin handles.
 *   No placeholder private state is written: that would persist meaningless
 *   admin state into a long-lived store for no benefit.
 */
async function findContract(providers, compiled, address) {
  const { findDeployedContract } = await import(pathToFileURL(STABLE_CONTRACTS_ESM).href);
  return findDeployedContract(providers, {
    compiledContract: compiled,
    contractAddress: address,
  });
}

function unshieldedTotal(unshieldedState) {
  const balances = unshieldedState?.balances ?? {};
  return Object.values(balances).reduce((a, b) => a + b, 0n);
}

// ---------------------------------------------------------------------------
// 4. main
// ---------------------------------------------------------------------------

const { secret: respondentSecret, origin: secretOrigin, path: secretPath } = resolveRespondentSecret();
const respondentSecretHex = secretToHex(respondentSecret);
// Register with the redacting logger so no SDK log line can echo it.
rememberSecret(respondentSecret);
rememberSecret(respondentSecretHex);
rememberSecret(SEED);

let adminSecret;
let adminSecretOrigin;
if (existsSync(ADMIN_SECRET_FILE)) {
  adminSecret = new Uint8Array(Buffer.from(readFileSync(ADMIN_SECRET_FILE, "utf8").trim(), "hex"));
  adminSecretOrigin = `loaded from ${ADMIN_SECRET_FILE}`;
} else {
  adminSecret = new Uint8Array(randomBytes(32));
  writeFileSync(ADMIN_SECRET_FILE, Buffer.from(adminSecret).toString("hex") + "\n", { mode: 0o600 });
  adminSecretOrigin = `freshly generated, stored (gitignored) in ${ADMIN_SECRET_FILE}`;
}
rememberSecret(adminSecret);
adminRuntimeSecret = adminSecret;

console.log("== Respondent invitation secret ==");
console.log(`  secret: ${secretOrigin}`);
console.log("  (value withheld; use --print-secret to display, or read the secret file)");

// The commitment is PUBLIC: it is inserted on-chain by registerParticipant.
const leaf = participantCommitmentOf(ledger8, respondentSecret);
console.log(`  commitment (public, on-chain leaf): ${Buffer.from(leaf).toString("hex")}`);

try {
  console.log("== Environment ==");
  const envConfig = buildEnvConfig();
  const { initializeMidnightProviders } = testkit;

  console.log("== Admin wallet ==");
  const adminCore = await startAdminWallet(envConfig, SEED);
  console.log(`  admin wallet ready: coin address ${adminCore.coinAddress}`);

  const adminProviders = initializeMidnightProviders(adminCore.wallet, envConfig, {
    privateStateStoreName: "feedback-preview-provisioner",
    zkConfigPath: ARTIFACT_DIR.replace(/\\/g, "/"),
  });

  // The admin identity must match the one pinned at construction, else this
  // wallet cannot authorize registerParticipant and the tx would fail for a
  // reason unrelated to the secret.
  const adminIdentity = adminIdentityOf(adminSecret);
  console.log(`  adminIdentity (public): ${Buffer.from(adminIdentity).toString("hex")}`);

  const address = stableTypes.asContractAddress(CONTRACT_ADDRESS);
  const chainState = await adminProviders.publicDataProvider.queryContractState(address);
  if (chainState === null || chainState === undefined) {
    throw new Error(
      `No on-chain state for ${CONTRACT_ADDRESS}. Refusing to provision: the contract does not exist on Preview.`,
    );
  }
  const initialLedger = ledgerOfChainState(chainState);
  const onChainAdmin = Buffer.from(initialLedger.adminAddress).toString("hex");
  if (onChainAdmin !== Buffer.from(adminIdentity).toString("hex")) {
    throw new Error(
      `Contract ${CONTRACT_ADDRESS} on Preview has adminAddress ${onChainAdmin.slice(0, 16)}… which does not match ` +
        `this run's admin identity. It was not deployed by this admin wallet — refusing to provision.`,
    );
  }
  console.log(
    `  on-chain ledger: surveyOpen=${initialLedger.surveyOpen} participantCount=${initialLedger.participantCount} ` +
      `responseCount=${initialLedger.responseCount}`,
  );
  console.log("  admin identity verified against on-chain constructor value");

  const adminCompiled = await makeCompiled();
  const joined = await findContract(adminProviders, adminCompiled, address);
  console.log("  verifier keys: byte-match confirmed (findDeployedContract attach succeeded)");

  console.log(`== Registering participant commitment to ${CONTRACT_ADDRESS} ==`);
  const finalized = await joined.callTx.registerParticipant(leaf);
  const res = await assertFinalized(adminProviders, finalized.public.txId, "registerParticipant");

  const afterLedger = ledgerOfChainState(
    await adminProviders.publicDataProvider.queryContractState(address),
  );
  console.log(
    `  participantCount: ${initialLedger.participantCount} -> ${afterLedger.participantCount}` +
      (afterLedger.participantCount > initialLedger.participantCount ? "" : "  (UNCHANGED — registration did not take effect)"),
  );

  // Persist the secret to the gitignored file the operator can paste from.
  // This is the ONLY place the secret is written by this script besides
  // explicit stdout on --print-secret.
  writeFileSync(secretPath, respondentSecretHex + "\n", { mode: 0o600 });
  console.log(`\n== Provisioning succeeded ==`);
  console.log(`  respondent secret written to ${secretPath} (gitignored, mode 600)`);
  console.log(`  registerParticipant txId: ${res.txId}`);
  console.log("  In the browser: open the invitation-secret import field and paste the value from that file.");
  if (PRINT_SECRET) {
    console.log("");
    console.log("  --print-secret requested, so the secret is shown once below.");
    console.log(`  RESPONDENT INVITE SECRET: ${respondentSecretHex}`);
    console.log("  (this value is a live credential for this survey — do not share it)");
  }
} catch (error) {
  console.error(`\n[FAILED] ${scrub(error instanceof Error ? error.message : String(error))}`);
  process.exit(1);
}