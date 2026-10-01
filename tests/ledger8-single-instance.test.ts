/**
 * Regression test: the retained ledger-8 runtime reaches the app through ONE
 * module specifier, and that specifier is the bare `compact-runtime-ledger8`.
 *
 * WHAT THIS PINS
 *   The generated retained artifact must import the BARE specifier, exactly as
 *   the official Midnight starter's `compile-retained.mjs` produces it:
 *
 *     import * as __compactRuntime from 'compact-runtime-ledger8';
 *
 *   The scoped form `'@midnight-ntwrk/compact-runtime-ledger8'` must NOT appear.
 *   That directory is an npm alias whose package.json declares
 *   `name: "@midnight-ntwrk/compact-runtime"`, i.e. the SAME declared package
 *   name as the v9 runtime. Vite keys optimized deps by declared package name,
 *   so a scoped specifier collapses onto the v9 optimizer key and the retained
 *   entry is dropped silently â€” which is why the retained runtime was never
 *   pre-bundled and `object-inspect` reached the browser as raw CommonJS.
 *
 *   With the bare specifier there is exactly one specifier in play, so the two
 *   copies can no longer be pulled apart: the app and the generated contract
 *   necessarily share one module namespace.
 *
 * WHY THE PREVIOUS SHAPE OF THIS TEST IS GONE
 *   It asserted that the bare and scoped specifiers were the SAME namespace,
 *   enforced by a `resolve.alias` collapsing one onto the other. That alias was
 *   the thing causing the optimizer name collision, so it was removed. The
 *   invariant it protected â€” a single instance â€” is now structural: there is one
 *   specifier, not two.
 *
 * NOT ASSERTED HERE
 *   The second axis, `@midnight-ntwrk/onchain-runtime-v3` instantiated twice by
 *   Vite's dependency optimizer, is browser-only (Vitest never runs the
 *   optimizer) and is pinned by `optimizeDeps.exclude` in vite.config.ts plus
 *   the manual in-page check documented at the bottom of this file.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** The bare alias, exactly as the generated v8 contract module imports it. */
const BARE = "compact-runtime-ledger8";
/** The scoped alias that must not appear in the generated artifact. */
const SCOPED = "@midnight-ntwrk/compact-runtime-ledger8";

const GENERATED_JS = resolve(process.cwd(), "managed/feedback-v8/contract/index.js");
const GENERATED_DTS = resolve(process.cwd(), "managed/feedback-v8/contract/index.d.ts");

type Runtime = Record<string, unknown>;

describe("retained ledger-8 runtime is a single module instance", () => {
  it("the generated retained contract imports the bare specifier", () => {
    const js = readFileSync(GENERATED_JS, "utf8");
    expect(js).toContain(`from '${BARE}'`);
  });

  it("the generated retained contract does not import the scoped alias", () => {
    const js = readFileSync(GENERATED_JS, "utf8");
    const dts = readFileSync(GENERATED_DTS, "utf8");
    expect(js).not.toContain(SCOPED);
    expect(dts).not.toContain(SCOPED);
  });

  it("the generated declarations pin the bare specifier too", () => {
    const dts = readFileSync(GENERATED_DTS, "utf8");
    expect(dts).toContain(`from '${BARE}'`);
  });

  it("exposes the three members the generated ledger() helper requires", async () => {
    const runtime = (await import(/* @vite-ignore */ BARE)) as Runtime;
    // The generated ledger() helper reads StateValue, branches on ChargedState,
    // and constructs QueryContext.
    expect(runtime.StateValue).toBeDefined();
    expect(runtime.ChargedState).toBeDefined();
    expect(runtime.QueryContext).toBeDefined();
  });

  it("gives StateValue and ChargedState stable class identities", async () => {
    const runtime = (await import(/* @vite-ignore */ BARE)) as Runtime;
    // Same specifier reached twice must be the same constructors. Distinct
    // constructors sharing a name are exactly what made the old failure read as
    // "expected instance of _ChargedState" instead of mentioning a duplicate.
    const again = (await import(/* @vite-ignore */ BARE)) as Runtime;
    expect(runtime.ChargedState).toBe(again.ChargedState);
    expect(runtime.StateValue).toBe(again.StateValue);
  });
});

/**
 * BROWSER-ONLY AXIS, VERIFIED IN THE PAGE
 *
 * `@midnight-ntwrk/onchain-runtime-v3` must be a SINGLE physical copy. It
 * cannot be asserted here: Vitest resolves with Node semantics and never runs
 * Vite's dependency optimizer, and the duplication was caused BY that optimizer
 * (esbuild inlines a wasm-bindgen package into a chunk per importer, so each
 * copy instantiates its own WASM and gets its own class identities).
 * `optimizeDeps.exclude` removes it in the browser build only.
 *
 * On the dev server, confirm the retained runtime and the onchain runtime agree:
 *
 *   Promise.all([
 *     import('/node_modules/.vite/deps/compact-runtime-ledger8.js'),
 *     import('/node_modules/@midnight-ntwrk/onchain-runtime-v3/midnight_onchain_runtime_wasm.js'),
 *   ]).then(([g, o]) => ({
 *     chargedStateSame: g.ChargedState === o.ChargedState,
 *     stateValueSame:   g.StateValue   === o.StateValue,
 *     contractStateSame:g.ContractState=== o.ContractState,
 *   }))
 *
 * A false in any of those three means `Ledger8InstanceMismatchError` will return.
 */
