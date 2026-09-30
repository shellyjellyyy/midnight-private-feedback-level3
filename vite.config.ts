import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
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

export default defineConfig({
  plugins: [react(), wasm(), midnightZkAssets()],
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
