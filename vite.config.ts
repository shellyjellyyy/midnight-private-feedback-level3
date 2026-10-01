import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { loadEnv } from "vite";
import type { ServerResponse } from "node:http";

/**
 * The managed/ directories sit in the repo but are not part of the Vite
 * module graph, so the browser cannot fetch ZK artifacts from them over HTTP.
 * The official starter solves this with a static mount; this plugin mounts
 * BOTH era directories for the dev server / `vite preview`:
 *
 *   /contract/managed/feedback     — current v9 artifact       (compactc 0.34.0)
 *   /contract/managed/feedback-v8  — retained Preview artifact (compactc 0.31.1)
 *
 * The frontend picks its route at build time (ZK_HTTP_ROUTE, see
 * src/lib/midnight/era.ts), so one dev server serves either era. `vite build`
 * does not copy managed/ into dist — production hosting of the ZK keys is a
 * deployment concern (static host/CDN), configured outside this file.
 *
 * Route shape — the on-disk layout the full `compact compile` emits is served
 * verbatim (the FetchZkConfigProvider convention matches it exactly):
 *   /contract/managed/feedback/compiler/contract-manifest.json
 *   /contract/managed/feedback/compiler/contract-info.json
 *   /contract/managed/feedback/zkir/<circuit>.bzkir
 *   /contract/managed/feedback/keys/<circuit>.prover
 *   /contract/managed/feedback/keys/<circuit>.verifier
 */
function midnightZkAssets(): Plugin {
  const mounts = [
    { route: "/contract/managed/feedback", base: resolve(__dirname, "managed/feedback") },
    { route: "/contract/managed/feedback-v8", base: resolve(__dirname, "managed/feedback-v8") },
  ];

  const serve = (path: string, res: ServerResponse) => {
    const data = readFileSync(path);
    const type: Record<string, string> = {
      ".json": "application/json",
      ".prover": "application/octet-stream",
      ".verifier": "application/octet-stream",
      ".zkir": "application/octet-stream",
      ".bzkir": "application/octet-stream",
    };
    res.setHeader("Content-Type", type[extname(path)] ?? "application/octet-stream");
    res.end(data);
  };

  return {
    name: "midnight-zk-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0];
        // The trailing slash keeps /feedback-v8 from matching the /feedback
        // mount (and vice versa).
        const mount = mounts.find((m) => url.startsWith(`${m.route}/`));
        if (!mount) return next();
        const rel = url.slice(mount.route.length + 1);
        const file = join(mount.base, rel);
        if (existsSync(file) && statSync(file).isFile()) {
          serve(file, res);
        } else {
          res.statusCode = 404;
          res.end();
        }
      });
    },
  };
}

/**
 * Publishes the PUBLIC ZK artifacts this build's era needs into `dist`, so a
 * deployed static host serves them at exactly the URLs the browser requests.
 *
 * WHY THIS EXISTS
 * `midnightZkAssets()` above only mounts `managed/` for `vite dev` /
 * `vite preview`. A real deployment serves `dist/`, and `vite build` does not
 * copy `managed/` into it, so every FetchZkConfigProvider request 404s after
 * deploy — the app builds and then cannot read the contract at runtime.
 *
 * The URLs are not guessed. `src/lib/midnight/providers.ts` constructs
 * FetchZkConfigProvider over `${window.location.origin}/contract/<artifactDir>`,
 * and the provider resolves every artifact under that base as:
 *
 *   compiler/contract-info.json       (ZK_CONTRACT_INFO_FILE_NAME)
 *   compiler/contract-manifest.json   (ZK_MANIFEST_DIR + ZK_MANIFEST_FILE_NAME)
 *   keys/<circuit>.prover             (getProverKey)
 *   keys/<circuit>.verifier           (getVerifierKey)
 *   zkir/<circuit>.bzkir              (getZKIR)
 *
 * and `ZKConfigRegistry.buildConfig` awaits all three per-circuit artifacts on
 * every proof. `contract/` itself is NOT copied: it is already bundled into
 * the JS, and only the key/IR material is fetched over HTTP.
 *
 * The circuit list is read from the generated `contract-info.json` rather than
 * hardcoded, so a contract change cannot silently desynchronise this step from
 * the artifact it publishes.
 *
 * FAIL LOUDLY. A missing artifact aborts the build. A deployment that shipped
 * without its verifier keys would look healthy and fail at proof time, in a
 * browser, with a 404 — the failure mode this plugin exists to prevent.
 *
 * ONE ERA PER BUILD. `ZK_HTTP_ROUTE` is resolved at build time from
 * VITE_MIDNIGHT_ERA, so a bundle only ever requests its own era's directory;
 * copying the other era's ~11 MB into dist would be dead weight.
 */
function midnightZkDeployAssets(): Plugin {
  // Captured from the resolved config rather than passed in, so this stays a
  // plain-object Vite config and still sees the real mode: `vite build` is
  // "production", `vite build --mode preview-era` is "preview-era".
  let mode = "production";
  return {
    name: "midnight-zk-deploy-assets",
    apply: "build",
    configResolved(config) {
      mode = config.mode;
    },
    writeBundle(options) {
      // Mirror src/lib/midnight/era.ts exactly: the route the browser will ask
      // for is decided by the same variable, so the copy cannot drift from it.
      const env = loadEnv(mode, __dirname, "");
      const era = env.VITE_MIDNIGHT_ERA === "v8-preview" ? "v8-preview" : "v9";
      const artifactDir = era === "v8-preview" ? "managed/feedback-v8" : "managed/feedback";
      const sourceRoot = resolve(__dirname, artifactDir);
      const outDir = resolve(__dirname, options.dir ?? "dist");
      // ZK_HTTP_ROUTE = `/contract/${MANAGED_ARTIFACT_DIR}`
      const destRoot = resolve(outDir, "contract", artifactDir);

      const infoPath = join(sourceRoot, "compiler/contract-info.json");
      if (!existsSync(infoPath)) {
        throw new Error(
          `[midnight-zk-deploy-assets] ${infoPath} is missing. Run \`npm run compile:${
            era === "v8-preview" ? "v8" : "v9"
          }\` before building — this build targets the ${era} era.`,
        );
      }
      const info = JSON.parse(readFileSync(infoPath, "utf8"));
      const circuits: string[] = info.circuits.map((c: { name: string }) => c.name);

      // contract-manifest.json is what makes v9's `verify: "require"` work.
      // compactc 0.31.1 (the retained era) emits no manifest, and that era's
      // provider deliberately uses "require-if-present" — so absence is
      // correct there and only an absence in v9 is a build error.
      const required = ["compiler/contract-info.json"];
      if (era !== "v8-preview") required.push("compiler/contract-manifest.json");
      for (const circuit of circuits) {
        required.push(`keys/${circuit}.prover`, `keys/${circuit}.verifier`, `zkir/${circuit}.bzkir`);
      }

      const missing = required.filter((rel) => !existsSync(join(sourceRoot, rel)));
      if (missing.length > 0) {
        throw new Error(
          `[midnight-zk-deploy-assets] refusing to build: ${missing.length} required ZK artifact(s) ` +
            `missing from ${artifactDir}/\n  - ${missing.join("\n  - ")}\n` +
            `Regenerate with \`npm run compile:${era === "v8-preview" ? "v8" : "v9"}\`.`,
        );
      }

      let bytes = 0;
      for (const rel of required) {
        const dest = resolve(destRoot, rel);
        mkdirSync(resolve(dest, ".."), { recursive: true });
        copyFileSync(join(sourceRoot, rel), dest);
        bytes += statSync(dest).size;
      }
      console.log(
        `\n[zk-assets] published ${required.length} ${era} artifact(s), ` +
          `${(bytes / 1024 / 1024).toFixed(2)} MB, to dist/contract/${artifactDir}/`,
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), wasm(), midnightZkAssets(), midnightZkDeployAssets()],
  // The Midnight SDK's browser stack expects the Node globals its bare
  // references read. @midnight-ntwrk/compact-runtime-ledger8 (and the v9
  // compact-runtime) call `Buffer.from(...)` as a GLOBAL, which a browser does
  // not provide; the runtime failure is "Buffer is not defined" the first time
  // findDeployedContract() decodes contract state.
  //
  // These match the official midnightntwrk/midnight-wallet-dapp starter, which
  // declares the same aliases plus a `src/polyfills.ts` that assigns
  // globalThis.Buffer. Both halves are required: the alias makes `buffer`/`process`
  // resolve to their browser builds, and the polyfill populates the global.
  /**
   * ONE physical onchain-runtime for the retained ledger-8 era.
   *
   * The same-named WASM package resolved to TWO copies in this browser bundle,
   * which `midnight-js-protocol`'s `assertSharedLedger8Instance` rejects with
   * `Ledger8InstanceMismatchError` ("two physically distinct copies of
   * onchain-runtime-v3"). Objects made by one copy are refused by the other
   * copy's classes, because each copy instantiates its own WASM bindings.
   *
   * The copies are DIFFERENT VERSIONS, so aliasing one onto the other would
   * silently change a version. `dedupe` is the correct tool instead: it makes
   * every importer in the BROWSER graph resolve to the single top-level
   * instance, and it does not touch Node. The nested copy lives under
   * `testkit-js-stable` (a devDependency used only by the Node provisioning
   * scripts, which resolve the retained runtime through the testkit on
   * purpose for bit-exactness) and must stay exactly as it is for those.
   *
* `compact-runtime-ledger8` and `onchain-runtime-v3` are the two axes the
   * retained-era stack crosses, so both are pinned.
   *
   * There is deliberately NO alias mapping `compact-runtime-ledger8` onto
   * `@midnight-ntwrk/compact-runtime-ledger8`. That scoped directory is an npm
   * alias whose package.json declares `name: "@midnight-ntwrk/compact-runtime"`,
   * so aliasing the bare specifier onto it collapses the retained runtime and the
   * v9 runtime onto ONE optimizer key. The generated retained artifact imports
   * the bare `compact-runtime-ledger8` directly (scripts/compile-contract.mjs),
   * matching the official starter, and `node_modules/compact-runtime-ledger8`
   * already resolves it to runtime 0.16.0.
   */
  resolve: {
    dedupe: [
      "@midnight-ntwrk/onchain-runtime-v3",
      "@midnight-ntwrk/compact-runtime",
    ],
    alias: {
      buffer: "buffer",
      process: "process/browser",
    },
  },
  // Some Midnight modules reference `global`; point it at the real global object
  // rather than letting it resolve to nothing. Same as the starter.
  define: {
    global: "globalThis",
  },
  /**
   * Do NOT pre-bundle `onchain-runtime-v3`.
   *
   * esbuild's dependency optimizer inlines a package into an optimized chunk of
   * its own, so a package reachable from two different importers is instantiated
   * TWICE, and the two instances own separate `ChargedState`/`StateValue` classes.
   * The object one copy builds is refused by the other's checks — which raised
   * `Ledger8InstanceMismatchError` ("two physically distinct copies of
   * onchain-runtime-v3") from midnight-js-protocol's own
   * `assertSharedLedger8Instance`. Keeping it out of the optimizer leaves it a
   * real ES module, resolved once by path, so there is exactly one instance.
   *
   * `ledger-v8` is excluded for the same reason.
   *
   * `compact-runtime-ledger8` is deliberately NOT excluded, and must not be:
   * it has to be pre-bundled so esbuild supplies the CommonJS interop for
   * `object-inspect`, which its `dist/error.js` default-imports from ESM. That
   * package is CommonJS (`object-inspect@1.13.4`: no `"type": "module"`, no
   * `exports` map), so served raw it has no ESM default export and the browser
   * throws `does not provide an export named 'default'` before the app renders.
   *
   * Excluding `onchain-runtime-v3` — not `compact-runtime-ledger8` — is what
   * removes the duplicate instances, so the interop and the single-instance
   * guarantee are compatible.
   */
  optimizeDeps: {
    /**
     * Force `compact-runtime-ledger8` into the optimized graph.
     *
     * Merely REMOVING it from `exclude` does not do this: `exclude` only says
     * "you may pre-bundle it", it does not put it in the graph. The optimizer ran
     * and emitted `@midnight-ntwrk/compact-runtime` — which transitively imports
     * `compact-runtime-ledger8` — yet never emitted a `compact-runtime-ledger8`
     * entry, so the package was served as a real ES module with its
     * un-interop'd CommonJS dependency intact.
     *
     * That matters because `dist/error.js` in that package does
     * `import inspect from "object-inspect"`, a default import of CommonJS
     * (`object-inspect@1.13.4`: no `"type": "module"`, no `exports` map). Only
     * esbuild's pre-bundling synthesises the ESM default export. Served raw, the
     * browser throws `does not provide an export named 'default'` and the app
     * never renders.
     *
     * Naming it in `include` is what makes the entry discovery actually happen.
     *
     * WHY THE v9 `@midnight-ntwrk/compact-runtime` MUST ALSO BE EXCLUDED
     * The alias target is a directory named `…/compact-runtime-ledger8`, but
     * its package.json declares `name: "@midnight-ntwrk/compact-runtime"` — it
     * is an npm alias (`npm:@midnight-ntwrk/compact-runtime@0.16.0`), not a
     * distinct package. Four directories in this tree declare that same name.
     *
     * Vite keys optimized deps by DECLARED PACKAGE NAME, not by requested
     * specifier. Requesting `@midnight-ntwrk/compact-runtime-ledger8` therefore
     * resolves to a package whose name is `@midnight-ntwrk/compact-runtime` — a
     * key the v9 0.19.0 runtime already occupies. The retained entry is then
     * dropped SILENTLY as a name collision, with no warning, in every optimizer
     * state tried (excluded, un-excluded, explicitly included).
     *
     * Excluding the v9 runtime does NOT help: it stays reachable through
     * `@midnight-ntwrk/compact-js`, so its key is never freed. Verified.
     *
     * The fix is upstream of this file. The retained artifact must import the
     * BARE specifier `compact-runtime-ledger8` — the official starter's form,
     * applied by scripts/compile-contract.mjs — so the retained runtime resolves
     * to a distinct optimizer entry and esbuild performs the CJS interop for
     * `object-inspect`. That specifier is the declared dependency name, not an
     * alias of the v9 one, so there is nothing to collapse and no `resolve.alias`
     * is needed for it. See the note on `resolve.alias` above.
     */
    include: ["compact-runtime-ledger8"],
    exclude: [
      "@midnight-ntwrk/onchain-runtime-v3",
      "@midnight-ntwrk/ledger-v8",
      "@midnightntwrk/ledger-v8",
    ],
  },
  build: {
    // The Midnight onchain runtime ships as WASM with top-level await; the
    // default esnext-free target cannot emit that.
    target: "esnext",
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
});
