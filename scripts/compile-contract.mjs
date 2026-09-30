#!/usr/bin/env node
/**
 * Deterministic, era-pinned compiler for BOTH artifacts built from the SAME
 * contracts/feedback.compact source. Never modifies the source.
 *
 *   node scripts/compile-contract.mjs v9    # current era: compactc 0.34.0
 *   node scripts/compile-contract.mjs v8    # retained era: compactc 0.31.1
 *
 * Era matrix (verified against live networks 2026-09-24/25: every public
 * network still runs ledger-v8, i.e. protocolVersion < 2000000):
 *
 *   v9 (current):  compactc 0.34.0 -> language 0.26.0, runtime 0.19.0
 *                  artifact managed/feedback   — deployable once a network
 *                  enacts the ledger-v9 fork (protocolVersion >= 2000000).
 *   v8 (retained): compactc 0.31.1 -> language 0.23.0, runtime 0.16.0
 *                  artifact managed/feedback-v8 — deployable on the live
 *                  Preview network TODAY.
 *
 * The retained build applies the OFFICIAL dual-build pattern from the Midnight
 * wallet dApp starter (scripts/compile-retained.mjs there): after compiling
 * with the old compiler, rewrite the generated import of
 * '@midnight-ntwrk/compact-runtime' to '@midnight-ntwrk/compact-runtime-ledger8'
 * (an npm alias pinned to compact-runtime 0.16.0, installed via devDependencies
 * as "@midnight-ntwrk/compact-runtime-ledger8": "npm:@midnight-ntwrk/compact-runtime@0.16.0").
 * This keeps runtime 0.16.0 and 0.19.0 from ever mixing: the v8 artifact can
 * only load the 0.16.0 runtime, the v9 artifact only the 0.19.0 one (each
 * generated module also hard-fails via checkRuntimeVersion on a wrong runtime).
 *
 * Compiler invocation: `compact compile +<version>` pins the compiler release
 * explicitly (no "latest"). On Windows the compiler lives inside WSL, so the
 * command is wrapped with `wsl -e bash -lc` and the paths are translated from
 * `C:\...` to `/mnt/c/...`. On Linux/macOS (including GitHub Actions) the
 * compiler is already Linux-side, so POSIX paths are passed through unchanged.
 * The translation rule itself lives in scripts/lib-compiler-path.mjs and is
 * covered by tests/compile-path.test.ts.
 *
 * Every step verifies its own output and fails loudly: compiler version in
 * compiler/contract-info.json, checkRuntimeVersion string in the generated
 * module, presence of prover/verifier keys + bzkir, and (v8 only) the alias
 * rewrite. File SHA-256s are printed as reproducibility evidence.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { compilerRunsInWsl, toCompilerPath } from "./lib-compiler-path.mjs";

const ERAS = {
  v9: {
    compiler: "0.34.0",
    runtime: "0.19.0",
    language: "0.26.0",
    outDir: "managed/feedback",
    alias: null,
    label: "current (v9 / ledger-v9-ready)",
  },
  v8: {
    compiler: "0.31.1",
    runtime: "0.16.0",
    language: "0.23.0",
    outDir: "managed/feedback-v8",
    alias: "@midnight-ntwrk/compact-runtime-ledger8",
    label: "retained (v8 / ledger-v8, live Preview)",
  },
};

const era = ERAS[process.argv[2] ?? ""];
if (!era) {
  console.error("usage: node scripts/compile-contract.mjs <v9|v8>");
  process.exit(2);
}

const repoRoot = process.cwd();
const source = resolve(repoRoot, "contracts/feedback.compact");
const outDir = resolve(repoRoot, era.outDir);
if (!existsSync(source)) {
  console.error(`[FATAL] contract source missing: ${source}`);
  process.exit(2);
}

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/**
 * Invoke the pinned Compact compiler over the resolved source/output paths.
 *
 * Paths handed to the compiler are translated by `toCompilerPath`: on Windows
 * the compiler lives inside WSL, so `C:\...` becomes `/mnt/c/...`; on
 * Linux/macOS (GitHub Actions included) the path is already POSIX and is
 * passed through untouched. See scripts/lib-compiler-path.mjs.
 */
function runCompactCompiler() {
  const args = `compact compile +${era.compiler} '${toCompilerPath(source)}' '${toCompilerPath(outDir)}'`;
  const cmd = compilerRunsInWsl()
    ? `wsl -e bash -lc "cd '${toCompilerPath(repoRoot)}' && ${args}"`
    : args;
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: repoRoot });
}

// ---------------------------------------------------------------------------
// 1. Compile (clean output dir first — no stale artifacts can survive).
// ---------------------------------------------------------------------------
console.log(`\n== Compiling ${era.label} ==`);
console.log(`  source:          contracts/feedback.compact (unchanged)`);
console.log(`  compiler:        compactc +${era.compiler} (pinned)`);
console.log(`  output:          ${era.outDir}/`);
rmSync(outDir, { recursive: true, force: true });
runCompactCompiler();

// ---------------------------------------------------------------------------
// 2. Verify the generated artifact against the pinned era matrix.
// ---------------------------------------------------------------------------
const infoPath = resolve(outDir, "compiler/contract-info.json");
if (!existsSync(infoPath)) {
  console.error(`[FATAL] compiler did not emit ${era.outDir}/compiler/contract-info.json`);
  process.exit(1);
}
const info = JSON.parse(readFileSync(infoPath, "utf8"));
const expectFail = (what, got, want) => {
  console.error(`[FATAL] ${what}: got ${got}, expected ${want} — compiler/toolchain drift. NOT keeping this artifact.`);
  process.exit(1);
};
if (info["compiler-version"] !== era.compiler) expectFail("compiler-version", info["compiler-version"], era.compiler);
if (info["runtime-version"] !== era.runtime) expectFail("runtime-version", info["runtime-version"], era.runtime);
if (info["language-version"] !== era.language) expectFail("language-version", info["language-version"], era.language);
console.log(`  contract-info:   compiler=${info["compiler-version"]} language=${info["language-version"]} runtime=${info["runtime-version"]}`);

const jsPath = resolve(outDir, "contract/index.js");
const dtsPath = resolve(outDir, "contract/index.d.ts");
let js = readFileSync(jsPath, "utf8");
const dts = readFileSync(dtsPath, "utf8");
if (!js.includes(`checkRuntimeVersion('${era.runtime}')`)) {
  console.error(`[FATAL] generated module does not enforce checkRuntimeVersion('${era.runtime}')`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. Retained era only: apply the official runtime-alias rewrite.
// ---------------------------------------------------------------------------
if (era.alias) {
  const BARE = "'@midnight-ntwrk/compact-runtime'";
  const count = js.split(BARE).length - 1 + (dts.split(BARE).length - 1);
  if (count === 0) {
    console.error(`[FATAL] no "${BARE}" import found to rewrite — unexpected generated shape`);
    process.exit(1);
  }
  writeFileSync(jsPath, js.split(BARE).join(`'${era.alias}'`));
  writeFileSync(dtsPath, dts.split(BARE).join(`'${era.alias}'`));
  js = readFileSync(jsPath, "utf8");
  const aliasDts = readFileSync(dtsPath, "utf8");
  if (js.includes(BARE) || aliasDts.includes(BARE)) {
    console.error("[FATAL] bare compact-runtime import survived the rewrite");
    process.exit(1);
  }
  if (!js.includes(`'${era.alias}'`) || !aliasDts.includes(`'${era.alias}'`)) {
    console.error(`[FATAL] alias ${era.alias} missing after rewrite`);
    process.exit(1);
  }
  console.log(`  alias rewrite:   '@midnight-ntwrk/compact-runtime' -> '${era.alias}' (official retained pattern; ${count} import site(s))`);
}

// ---------------------------------------------------------------------------
// 4. Verify the deployment-critical artifact set (keys + bzkir per circuit).
// ---------------------------------------------------------------------------
const circuits = info.circuits.map((c) => c.name);
const missing = [];
for (const c of circuits) {
  for (const rel of [`keys/${c}.prover`, `keys/${c}.verifier`, `zkir/${c}.bzkir`]) {
    if (!existsSync(resolve(outDir, rel))) missing.push(rel);
  }
}
if (missing.length > 0) {
  console.error(`[FATAL] artifact missing deployment-critical files: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`  circuits:        ${circuits.join(", ")} — keys + bzkir present`);

// ---------------------------------------------------------------------------
// 5. Reproducibility evidence.
// ---------------------------------------------------------------------------
const files = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(p);
  }
};
walk(outDir);
files.sort();
console.log(`\n== ${era.outDir} artifact manifest (${files.length} files) ==`);
for (const f of files) {
  console.log(`  ${sha256(f).slice(0, 16)}  ${f.slice(repoRoot.length + 1)}`);
}
console.log(`\nOK: ${era.outDir} compiled with compactc ${era.compiler} / runtime ${era.runtime}${era.alias ? ` (runtime aliased to ${era.alias})` : ""}.`);
