/**
 * Browser runtime polyfill for the Midnight SDK.
 *
 * WHY THIS EXISTS
 *   The retained ledger-v8 Preview path reaches
 *
 *     findDeployedContract()
 *       -> @midnight-ntwrk/compact-runtime-ledger8/dist/utils.js
 *       -> fromHex / toHex  ->  Buffer.from(value, "hex")
 *
 *   and that module references the Node GLOBAL `Buffer` without importing it.
 *   A browser has no such global, so the call throws
 *   `ReferenceError: Buffer is not defined` the moment contract state is
 *   decoded — which is why the failure appears only on Submit, after the join
 *   has already read the chain successfully.
 *
 *   Node never hit this: `Buffer` is a real global there, so the same module
 *   runs unmodified on the CLI path. That difference is the whole bug.
 *
 *   Midnight modules that `import { Buffer } from 'buffer'` already work — the
 *   npm `buffer` package is already in the bundle as their transitive
 *   dependency. What was missing is the GLOBAL those bare references read.
 *
 * THIS IS THE ARCHITECTURE THE SDK EXPECTS
 *   The official `midnightntwrk/midnight-wallet-dapp` starter ships an
 *   equivalent `src/polyfills.ts` and imports it first from its entry point.
 *   This mirrors it rather than patching individual call sites, so every
 *   affected module — including the v9 `@midnight-ntwrk/compact-runtime`, which
 *   carries the same defect — is covered without being enumerated.
 *
 * GUARDED, NOT OVERWRITING
 *   The assignment is skipped when a `Buffer` global already exists, so a host
 *   that provides its own (a test harness, an extension-injected shim, a future
 *   browser) keeps it. This file therefore only ever fills a gap.
 *
 * NO SECRETS, NO DIAGNOSTICS
 *   Nothing is read, logged, or recorded here. It assigns one global and
 *   returns.
 */

import { Buffer as BufferPolyfill } from "buffer";

type GlobalWithBuffer = {
  Buffer?: unknown;
};

/**
 * Installs the `Buffer` global if one is absent.
 *
 * Exported so the behaviour can be asserted directly rather than inferred from
 * a side effect of importing the module.
 *
 * @returns true when this call installed the polyfill, false when a `Buffer`
 *   global was already present and left untouched.
 */
export function installBufferPolyfill(target: GlobalWithBuffer = globalThis as GlobalWithBuffer): boolean {
  if (typeof target.Buffer !== "undefined") return false;
  target.Buffer = BufferPolyfill;
  return true;
}

installBufferPolyfill();