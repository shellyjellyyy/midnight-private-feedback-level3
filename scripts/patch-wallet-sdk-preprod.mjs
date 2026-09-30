#!/usr/bin/env node
/**
 * node_modules compatibility patches, in two independent groups:
 *
 * GROUP A — "stable-stack patch" (Preview / retained-era, testkit-js 4.0.4):
 *   testkit-js 4.0.4 imports `InMemoryTransactionHistoryStorage` from
 *   @midnight-ntwrk/wallet-sdk-unshielded-wallet, but published 3.1.0 moved that
 *   export to @midnightntwrk/wallet-sdk-abstractions (verified by inspecting the
 *   published tarballs). The installed unshielded-wallet gains a re-export so the
 *   testkit's named import resolves. Applies to BOTH top-level scoped copies
 *   (hyphenated @midnight-ntwrk — what the stable testkit resolves — and
 *   @midnightntwrk, kept hoisted for other consumers).
 *
 * GROUP B — "Preprod-era patches" (v9, testkit-js 5.0.0-beta.8):
 *   EMPIRICAL BASIS (verified 2026-09-25 against the live Preprod indexer at
 *   indexer.preprod.midnight.network/api/v4/graphql):
 *
 *   P1  The beta.3 sync subscription selects `protocolVersion` inside
 *       `... on UnshieldedTransactionsProgress`, but the live indexer's
 *       `UnshieldedTransactionsProgress` has ONLY `highestTransactionId`.
 *       The server rejects the sync subscription outright
 *       (Unknown field "protocolVersion" ...) and the wallet can never sync.
 *       Fix: drop the selection (wire) + guard the consumer (withVersionSignal)
 *       + make the decode schema field optional.
 *
 *   P2  The beta.3 dust subscription calls `dustGenerations(blockHash:,
 *       dtimeCutoffHeight:)`, but the live field signature is
 *       `dustGenerations(dustAddress:, startIndex:, endIndex:)` — blockHash and
 *       dtimeCutoffHeight do not exist and startIndex/endIndex are required.
 *       Fix: rewrite the document's root arguments and the caller's variables.
 *
 *   P3  The live server omits `protocolVersion` inside collapsedMerkleTree
 *       payloads the dust path decodes. Fix: make those schema fields optional;
 *       consumers already tolerate absence (version annotation is best-effort).
 *
 *   IMPORTANT (2026-09-25): with wallet-sdk 1.2.0 also installed, npm hoists
 *   schema-compatible 1.2.x wallet packages to the TOP level; the beta.3 stack
 *   the beta.8 testkit actually resolves lives NESTED under
 *   node_modules/@midnight-ntwrk/testkit-js/node_modules/@midnightntwrk/.
 *   Group B therefore targets the nested copies and is skipped entirely when
 *   that nested stack is absent.
 *
 * Idempotent: re-running is a no-op. Group B is self-verifying: it re-checks the
 * live schema assumption via introspection and refuses to patch if it changed.
 *
 * WHY A PATCH AT ALL: node_modules patches are lost on every npm install, so
 * this file is the durable record AND the one-command repair:
 *   node scripts/patch-wallet-sdk-preprod.mjs
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

// The Preprod (v9) patches only apply to the beta.3 wallet stack nested under
// the beta.8 testkit. Detection is by the nested indexer-client, the same
// package whose wire documents every Group-B patch edits.
const NESTED = "node_modules/@midnight-ntwrk/testkit-js/node_modules/@midnightntwrk";
const BETA8_INDEXER_CLIENT = `${NESTED}/wallet-sdk-indexer-client/dist/graphql/generated/graphql.js`;

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 16);

async function verifyAssumption() {
  const q = { query: '{ __type(name: "UnshieldedTransactionsProgress") { fields { name } } }' };
  const r = await fetch("https://indexer.preprod.midnight.network/api/v4/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(q),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json();
  const names = (j.data?.__type?.fields ?? []).map((f) => f.name);
  console.log("live schema UnshieldedTransactionsProgress fields:", names.join(", ") || "(none)");
  if (!names.includes("highestTransactionId") || names.includes("protocolVersion")) {
    console.log("Schema has changed — patch assumptions no longer hold. Not patching.");
    return false;
  }
  return true;
}

const stablePatches = [
  {
    file: "node_modules/@midnight-ntwrk/wallet-sdk-unshielded-wallet/dist/index.js",
    label: "stable-stack re-export in @midnight-ntwrk (hyphenated) unshielded-wallet",
  },
  {
    file: "node_modules/@midnightntwrk/wallet-sdk-unshielded-wallet/dist/index.js",
    label: "stable-stack re-export in @midnightntwrk unshielded-wallet",
  },
];

const preprodPatches = [
  // P1a — the wire document (generated): stop selecting the unknown field.
  {
    file: `${NESTED}/wallet-sdk-indexer-client/dist/graphql/generated/graphql.js`,
    from: '{ "kind": "Field", "name": { "kind": "Name", "value": "highestTransactionId" } }, { "kind": "Field", "name": { "kind": "Name", "value": "protocolVersion" } }',
    to: '{ "kind": "Field", "name": { "kind": "Name", "value": "highestTransactionId" } }',
    label: "P1a indexer-client generated sync subscription",
  },
  // P1b — the readable subscription source (same document, second copy).
  {
    file: `${NESTED}/wallet-sdk-indexer-client/dist/graphql/subscriptions/UnshieldedTransactions.js`,
    from: "        ... on UnshieldedTransactionsProgress {\n          type: __typename\n          highestTransactionId\n          protocolVersion\n        }",
    to: "        ... on UnshieldedTransactionsProgress {\n          type: __typename\n          highestTransactionId\n        }",
    label: "P1b indexer-client readable sync subscription",
  },
  // P1c — the consumer must not BigInt() an absent field.
  {
    file: `${NESTED}/wallet-sdk-unshielded-wallet/dist/v1/Sync.js`,
    from: "const withVersionSignal = (update, knownVersion) => update.type === 'UnshieldedTransactionsProgress' &&\n    update.protocolVersion !== 0 &&\n    BigInt(update.protocolVersion) > knownVersion\n    ? [update, VersionSignalSyncUpdate.create(update.protocolVersion, update.highestTransactionId)]\n    : [update];",
    to: "const withVersionSignal = (update, knownVersion) => update.type === 'UnshieldedTransactionsProgress' &&\n    update.protocolVersion !== undefined &&\n    update.protocolVersion !== 0 &&\n    BigInt(update.protocolVersion) > knownVersion\n    ? [update, VersionSignalSyncUpdate.create(update.protocolVersion, update.highestTransactionId)]\n    : [update];",
    label: "P1c unshielded-wallet withVersionSignal guard",
  },
  // P1d — the decode schema must accept the field's absence.
  {
    file: `${NESTED}/wallet-sdk-unshielded-wallet/dist/v1/SyncSchema.js`,
    from: "    highestTransactionId: Schema.Number,\n    /**\n     * The protocol version at the CHAIN'S tip — not the version of anything on this address's timeline, which may be far\n     * behind it or empty. Zero is not a version: it is the source reporting that it has indexed no block yet.\n     */\n    protocolVersion: Schema.Number,",
    to: "    highestTransactionId: Schema.Number,\n    /**\n     * The protocol version at the CHAIN'S tip — not the version of anything on this address's timeline, which may be far\n     * behind it or empty. Zero is not a version: it is the source reporting that it has indexed no block yet.\n     *\n     * PREPROD PATCH: optional. The live Preprod indexer's progress frames carry\n     * no protocolVersion field at all (verified against the live schema).\n     */\n    protocolVersion: Schema.optional(Schema.Number),",
    label: "P1d unshielded-wallet ProgressSchema optional protocolVersion",
  },
  // P2a — the dust subscription document: adapt to the live argument shape.
  {
    file: `${NESTED}/wallet-sdk-indexer-client/dist/graphql/subscriptions/DustGenerationEvents.js`,
    from: "    subscription DustGenerations($dustAddress: DustAddress!, $blockHash: HexEncoded!, $dtimeCutoffHeight: Int!) {\n      dustGenerations(dustAddress: $dustAddress, blockHash: $blockHash, dtimeCutoffHeight: $dtimeCutoffHeight) {",
    to: "    subscription DustGenerations($dustAddress: DustAddress!, $startIndex: Int!, $endIndex: Int!) {\n      dustGenerations(dustAddress: $dustAddress, startIndex: $startIndex, endIndex: $endIndex) {",
    label: "P2a dust subscription document (live argument shape)",
  },
  // P2b — the dust caller: pass the live-shaped variables.
  {
    file: `${NESTED}/wallet-sdk-dust-wallet/dist/v2/Sync.js`,
    from: "            return pipe(DustGenerationEvents.run({\n                dustAddress,\n                blockHash: latestBlock.hash,\n                dtimeCutoffHeight: lastSyncedBlockHeight,\n            }),",
    to: "            return pipe(DustGenerationEvents.run({\n                dustAddress,\n                // PREPROD PATCH: the live indexer takes a generation-MT index\n                // window rather than block-hash/dtime cutoffs. The old values\n                // are folded into a window that keeps the same\n                // \"resume-from-last-sync\" semantics as best the live schema\n                // allows; startIndex 0 re-streams the window on every tick.\n                startIndex: 0,\n                endIndex: Number(maxGeneratingTreeIndex) + 1000,\n            }),",
    label: "P2b dust-wallet caller variables",
  },
  // P3a — collapsedMerkleTree.protocolVersion made optional in the dust path.
  {
    file: `${NESTED}/wallet-sdk-dust-wallet/dist/v2/SyncSchema.js`,
    from: "protocolVersion: Schema.Number",
    to: "protocolVersion: Schema.optional(Schema.Number)",
    allowMultiple: true,
    label: "P3 dust SyncSchema optional collapsedMerkleTree.protocolVersion",
  },
];

// GROUP A — stable-stack (Preview) re-export management.
//
// TWO stable-stack generations exist and need OPPOSITE treatment:
//
//  - testkit-js 4.0.4 imports InMemoryTransactionHistoryStorage directly from
//    @midnight-ntwrk/wallet-sdk-unshielded-wallet, but published 3.1.0 moved
//    that export to @midnightntwrk/wallet-sdk-abstractions. Without an
//    umbrella package present, a re-export appended to unshielded-wallet is
//    the only fix.
//
//  - testkit-js 4.1.x imports everything from the @midnight-ntwrk/wallet-sdk
//    UMBRELLA, which star-exports BOTH abstractions (where the symbol lives
//    natively) AND unshielded-wallet. Appending the re-export there then
//    produces "conflicting star exports for name
//    'InMemoryTransactionHistoryStorage'" — so under an umbrella stack the
//    patch must be REMOVED, not applied.
//
// The patch is self-describing (sentinel comment + single known line), so
// removal is exact and safe to re-run.
const PATCH_SENTINEL = "// PREPROD/STABLE-STACK PATCH: re-export moved to abstractions in newer publishes";
const PATCH_LINE = "export { InMemoryTransactionHistoryStorage } from '@midnightntwrk/wallet-sdk-abstractions';";
const UMBRELLA_PKG = "node_modules/@midnight-ntwrk/wallet-sdk/package.json";
const umbrellaStack = existsSync(UMBRELLA_PKG);

for (const sp of stablePatches) {
  if (!existsSync(sp.file)) continue;
  const original = readFileSync(sp.file, "utf8");
  const hasPatch = original.includes(PATCH_SENTINEL);
  if (umbrellaStack) {
    if (hasPatch) {
      const lines = original.split("\n");
      const cleaned = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(PATCH_SENTINEL)) {
          i++; // skip the sentinel line AND the re-export line that follows
          if (lines[i]?.trim() === PATCH_LINE) continue;
        }
        cleaned.push(lines[i]);
      }
      writeFileSync(sp.file, cleaned.join("\n"));
      console.log("REMOVED re-export patch (umbrella stack re-exports it natively):", sp.label);
    } else {
      console.log("clean (umbrella stack, no patch needed):", sp.label);
    }
  } else if (!original.includes("InMemoryTransactionHistoryStorage")) {
    const patched = original + "\n" + PATCH_SENTINEL + "\n" + PATCH_LINE + "\n";
    writeFileSync(sp.file, patched);
    console.log("patched:", sp.label);
  } else {
    console.log("already patched (or natively present):", sp.label);
  }
}

// GROUP B — Preprod-era (v9) schema patches, only when the nested beta.3 stack exists.
const beta8Stack = existsSync(BETA8_INDEXER_CLIENT);
if (!beta8Stack) {
  console.log("beta.8 v9 stack not detected (no nested beta.3 wallet packages) — skipping Preprod-era schema patches.");
} else {
  const assumptionHolds = await verifyAssumption();
  if (assumptionHolds) {
    for (const p of preprodPatches) {
      if (!existsSync(p.file)) {
        console.log(`skip (file absent): ${p.file}`);
        continue;
      }
      const original = readFileSync(p.file, "utf8");
      const alreadyPatched = p.allowMultiple
        ? !original.includes(p.from)
        : original.includes(p.to) && !original.includes(p.from);
      if (alreadyPatched) {
        console.log(`already patched: ${p.label}`);
        continue;
      }
      if (!original.includes(p.from)) {
        console.error(`PATTERN NOT FOUND for ${p.label} in ${p.file} — upstream changed; refusing to patch blindly.`);
        process.exit(1);
      }
      const patched = p.allowMultiple
        ? original.split(p.from).join(p.to)
        : original.replace(p.from, p.to);
      writeFileSync(p.file, patched);
      const after = readFileSync(p.file, "utf8");
      if (p.allowMultiple ? after.includes(p.from) : !after.includes(p.to)) {
        console.error(`PATCH FAILED VERIFICATION for ${p.label}`);
        process.exit(1);
      }
      console.log(`patched ${p.label}`);
      console.log(`  ${sha256(Buffer.from(original))} -> ${sha256(Buffer.from(after))}`);
    }
  }
}

console.log("done.");
