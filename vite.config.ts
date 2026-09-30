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
  resolve: {
    alias: {
      buffer: "buffer",
      process: "process/browser",
      /**
       * ONE physical compact-runtime for the retained ledger-8 era.
       *
       * The retained-era runtime reaches the bundle under TWO different module
       * specifiers, and both resolve to the same version of the same package:
       *
       *   "compact-runtime-ledger8"                 -> node_modules/compact-runtime-ledger8
       *   "@midnight-ntwrk/compact-runtime-ledger8" -> node_modules/@midnight-ntwrk/compact-runtime-ledger8
       *
       * The first is pulled in transitively, as a bare npm alias, by
       * `@midnight-ntwrk/midnight-js-protocol` (see its `createLedger8Engine`,
       * which does `import('compact-runtime-ledger8')`). The second is the
       * scoped devDependency alias this project declares, and it is the name
       * the generated v8 contract module imports
       * (`managed/feedback-v8/contract/index.js`).
       *
       * Two directories means TWO module instances, so `ChargedState` and
       * `StateValue` get two different class identities. TypeScript sees one
       * type and stays quiet; at runtime every `instanceof` and every
       * wasm-bindgen constructor downcast between the two copies FAILS, which
       * surfaced as `expected instance of _ChargedState` thrown from the
       * generated module's `ledger()` helper when the retained-era engine's
       * decoded state reached it.
       *
       * `midnight-js-protocol` already guards this class of bug with
       * `assertSharedLedger8Instance`, but only on the `onchain-runtime-v3`
       * axis — it compares the runtime against its OWN copy and never against
       * the copy the generated contract holds, so it passes here.
       *
       * Aliasing the bare specifier onto the scoped one collapses both onto a
       * single instance. No package is upgraded, downgraded or reinstalled;
       * both names already request the identical version
       * (compact-runtime 0.16.0).
       */
      "compact-runtime-ledger8": "@midnight-ntwrk/compact-runtime-ledger8",
    },
  },
  // Some Midnight modules reference `global`; point it at the real global object
  // rather than letting it resolve to nothing. Same as the starter.
  define: {
    global: "globalThis",
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
