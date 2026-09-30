#!/usr/bin/env node
/**
 * INDEPENDENT verification of the real Preview deployment — deliberately uses
 * only plain `fetch` against the public Preview indexer GraphQL API and the
 * RETAINED artifact's own ledger deserializer (managed/feedback-v8). It does
 * NOT use the deploy script or the SDK public-data provider, and never prints
 * secrets — privacy checks output booleans only.
 *
 * Usage:
 *   node scripts/verify-preview-deployment.mjs <contractAddress> [txId ...]
 *
 * Reports: contract existence, deploy tx id/hash/block/finalization (status +
 * per-segment success), given tx finalization, initial/current public ledger
 * state, and privacy booleans (admin secret / comment digest / comment
 * plaintext / wallet seeds absent from public state hex).
 */
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const INDEXER_HTTP = "https://indexer.preview.midnight.network/api/v4/graphql";
const [address, ...txIds] = process.argv.slice(2);
if (!address || !/^[0-9a-f]{64}$/i.test(address)) {
  console.error("usage: node scripts/verify-preview-deployment.mjs <contractAddress: 64-hex> [txId ...]");
  process.exit(2);
}

async function gql(query, variables) {
  const r = await fetch(INDEXER_HTTP, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json();
  if (j.errors) throw new Error(`GraphQL errors: ${JSON.stringify(j.errors)}`);
  return j.data;
}

const out = { network: "preview", contractAddress: address };

// 1. Contract existence + deploy tx (contractAction returns null when the
//    contract does not exist — independent of any SDK call).
const deployData = await gql(
  `query ($address: HexEncoded!) {
     contractAction(address: $address) {
       ... on ContractDeploy {
         transaction {
           id hash protocolVersion
           block { height hash author timestamp }
           ... on RegularTransaction {
             transactionResult { status segments { id success } }
           }
         }
       }
       ... on ContractUpdate {
         transaction {
           id hash protocolVersion
           block { height hash author timestamp }
           ... on RegularTransaction {
             transactionResult { status segments { id success } }
           }
         }
       }
       ... on ContractCall {
         deploy {
           transaction {
             id hash protocolVersion
             block { height hash author timestamp }
             ... on RegularTransaction {
               transactionResult { status segments { id success } }
             }
           }
         }
       }
     }
   }`,
  { address },
);
const action = deployData?.contractAction ?? null;
out.contractExistsOnIndexer = action !== null;

const deployTx = action
  ? action.transaction ?? action.deploy?.transaction ?? null
  : null;
if (deployTx) {
  out.deployTx = {
    id: deployTx.id,
    hash: deployTx.hash,
    protocolVersion: deployTx.protocolVersion,
    block: deployTx.block,
    transactionResult: deployTx.transactionResult,
    allSegmentsSuccessful:
      Array.isArray(deployTx.transactionResult?.segments) &&
      deployTx.transactionResult.segments.every((s) => s.success === true),
  };
}

// 2. Contract state (deploy state) + current state, decoded by the RETAINED
//    artifact's own ledger deserializer.
const stateData = await gql(
  `query ($address: HexEncoded!) {
     contractAction(address: $address) { state }
   }`,
  { address },
);
const currentStateHex = stateData?.contractAction?.state ?? null;

const managed = await import(
  pathToFileURL(resolve("managed/feedback-v8/contract/index.js")).href
);
// The alias runtime is shimmed (2026-09-27) to re-export the stable stack's
// compact-runtime instance, so StateValue.decode here yields the SAME class
// the managed module checks with `instanceof`.
const runtime = await import("@midnight-ntwrk/compact-runtime-ledger8");
const decodeLedger = (stateHex) => {
  const bytes = Buffer.from(stateHex, "hex");
  const stateValue = runtime.StateValue.decode(bytes);
  const l = managed.ledger(stateValue);
  return {
    surveyOpen: l.surveyOpen,
    participantCount: l.participantCount,
    responseCount: l.responseCount,
    rating1: String(l.rating1),
    rating2: String(l.rating2),
    rating3: String(l.rating3),
    rating4: String(l.rating4),
    rating5: String(l.rating5),
    usedNullifiersCount: l.usedNullifiers.size(),
    adminAddress: Buffer.from(l.adminAddress).toString("hex"),
  };
};

if (currentStateHex) {
  try {
    out.currentPublicState = decodeLedger(currentStateHex);
  } catch (e) {
    out.currentPublicStateDecodeError = String(e).slice(0, 300);
  }
}

// 3. Finalization of any additional tx ids given on the command line.
out.additionalTxs = [];
for (const txId of txIds) {
  const d = await gql(
    `query ($id: TransactionOffset!) {
       transactions(offset: $id) {
         id hash block { height hash timestamp }
         ... on RegularTransaction {
           transactionResult { status segments { id success } }
         }
       }
     }`,
    // TransactionOffset is an INPUT_OBJECT: { hash } or { identifier }.
    // submitTransaction()/deploy results expose the identifier form; a bare
    // string is rejected by the schema (observed live 2026-09-27).
    { id: { identifier: txId } },
  );
  const t = d?.transactions ?? null;
  out.additionalTxs.push({
    requestedId: txId,
    found: t !== null,
    id: t?.id,
    hash: t?.hash,
    block: t?.block,
    transactionResult: t?.transactionResult ?? null,
    allSegmentsSuccessful:
      Array.isArray(t?.transactionResult?.segments) &&
      t.transactionResult.segments.every((s) => s.success === true),
  });
}

// 4. Privacy booleans — secrets are READ silently and only reported as
//    "present in public state: true/false". Never printed.
const stateLower = (currentStateHex ?? "").toLowerCase();
const hexOf = (buf) => Buffer.from(buf).toString("hex").toLowerCase();
const contains = (hex) => hex && stateLower.includes(hex);

const adminSecretFile = ".admin-secret-preview";
const adminSecretHex = existsSync(adminSecretFile)
  ? readFileSync(adminSecretFile, "utf8").trim().toLowerCase()
  : null;
const commentText = "great survey, thanks!";
const commentDigestHex = hexOf(
  createHash("sha256").update(Buffer.from(commentText, "utf8")).digest(),
);
const commentPlainHex = hexOf(Buffer.from(commentText, "utf8"));
const seeds = [".participant-seed-preview", ".admin-seed-preview"]
  .filter(existsSync)
  .map((f) => readFileSync(f, "utf8").trim().toLowerCase());

out.privacy = {
  adminSecretAbsentFromPublicState: adminSecretHex ? !contains(adminSecretHex) : "admin-secret-file-absent",
  commentDigestAbsentFromPublicState: !contains(commentDigestHex),
  commentPlaintextAbsentFromPublicState: !contains(commentPlainHex),
  walletSeedsAbsentFromPublicState: seeds.every((s) => !contains(s)),
  note: "Public state IS the rating tally by design; leaves/commitments registered on-chain are public; nullifiers are public one-way values.",
};

console.log(JSON.stringify(out, null, 2));
