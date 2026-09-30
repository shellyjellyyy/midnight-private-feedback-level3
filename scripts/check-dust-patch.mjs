#!/usr/bin/env node
/**
 * Offline, deterministic verification of the DUST patch
 * (scripts/patch-dust-empty-actions.mjs).
 *
 * This exists so CI can prove the four properties the README claims, on every
 * push, without a wallet, a seed, a node, a proof server or a funded Preview
 * account:
 *
 *   1. APPLIES        both anchors land in both v8-era targets
 *   2. IDEMPOTENT     a second apply changes nothing
 *   3. REVERSIBLE     --revert restores each file BYTE-EXACTLY (sha256)
 *   4. ERA-SEPARATED  the nested v9-era beta.3 copy is left UNTOUCHED
 *
 * Property 4 is the one that matters most for review: if this patch ever
 * leaked into the v9 tree, the era separation the whole repository depends on
 * would be silently destroyed.
 *
 * It mutates only node_modules, which npm ci rewrites anyway, and it always
 * leaves the patch APPLIED at the end — the state deploy-preview.mjs requires.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const SENTINEL = "patch-dust-empty-actions.mjs): never emit an empty DustActions";
const SENTINEL_LOOP = "patch-dust-empty-actions.mjs): price WITHOUT the empty DustActions";

const PATCH_TARGETS = [
  "node_modules/@midnight-ntwrk/wallet-sdk-dust-wallet",
  "node_modules/@midnightntwrk/wallet-sdk-dust-wallet",
];
const ERA_V9_COPY = "node_modules/@midnight-ntwrk/testkit-js/node_modules/@midnightntwrk/wallet-sdk-dust-wallet";

const transactingOf = (pkg) => resolve(pkg, "dist/v1/Transacting.js");
const sha256Text = (t) => createHash("sha256").update(Buffer.from(t, "utf8")).digest("hex");
const runPatch = (...args) =>
  execFileSync(process.execPath, [resolve("scripts/patch-dust-empty-actions.mjs"), ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

// Start from the PRISTINE upstream text so the byte-exactness check has a real
// baseline to compare against. --revert is a no-op on an already-clean file.
console.log("== 0. capture pristine upstream baseline ==");
runPatch("--revert");
const pristine = new Map();
for (const pkg of PATCH_TARGETS) {
  if (existsSync(transactingOf(pkg))) pristine.set(pkg, readFileSync(transactingOf(pkg), "utf8"));
}

console.log("== 1. apply ==");
runPatch();
for (const pkg of pristine.keys()) {
  const text = readFileSync(transactingOf(pkg), "utf8");
  check(text !== pristine.get(pkg), `${pkg}: apply actually changed the file`);
  check(text.includes(SENTINEL), `${pkg}: balanceTransactions anchor applied`);
  check(text.includes(SENTINEL_LOOP), `${pkg}: dryRunFee anchor applied`);
}

console.log("== 2. idempotent ==");
const afterFirstApply = new Map(
  [...pristine.keys()].map((pkg) => [pkg, readFileSync(transactingOf(pkg), "utf8")]),
);
runPatch();
for (const pkg of pristine.keys()) {
  check(
    readFileSync(transactingOf(pkg), "utf8") === afterFirstApply.get(pkg),
    `${pkg}: re-applying changed nothing`,
  );
}

console.log("== 3. reversible (byte-exact) ==");
runPatch("--revert");
for (const pkg of pristine.keys()) {
  const after = readFileSync(transactingOf(pkg), "utf8");
  check(!after.includes(SENTINEL) && !after.includes(SENTINEL_LOOP), `${pkg}: sentinels removed on revert`);
  check(sha256Text(after) === sha256Text(pristine.get(pkg)), `${pkg}: revert is byte-exact`);
}
runPatch();

console.log("== 4. era separation (nested v9-era copy untouched) ==");
if (existsSync(resolve(ERA_V9_COPY, "package.json"))) {
  const v9File = transactingOf(ERA_V9_COPY);
  if (existsSync(v9File)) {
    const v9Text = readFileSync(v9File, "utf8");
    check(!v9Text.includes(SENTINEL) && !v9Text.includes(SENTINEL_LOOP), "nested v9-era beta.3 copy carries NO patch sentinel");
  } else {
    console.log("  skip: nested v9-era copy has no dist/v1/Transacting.js");
  }
} else {
  console.log("  skip (not installed): nested v9-era copy");
}

console.log("== 5. resolution graph (v8/v9 era separation) ==");
try {
  console.log(
    execFileSync(process.execPath, [resolve("scripts/check-resolution-graph.mjs")], { encoding: "utf8" }).trim(),
  );
  check(true, "check:resolutions passed");
} catch (e) {
  console.error(String(e.stdout ?? e.message));
  check(false, "check:resolutions passed");
}

if (failures > 0) {
  console.error(`\nFAIL: ${failures} dust-patch check(s) failed.`);
  process.exit(1);
}
console.log("\nOK: DUST patch applies, is idempotent, is byte-exactly reversible, and preserves era separation.");
