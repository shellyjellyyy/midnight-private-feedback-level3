// Guards the v8/v9 era separation: no stable-stack package may resolve a
// runtime class-provider to the TOP-LEVEL (beta.8-era) copy — that split caused
// the live "expected instance of ContractMaintenanceAuthority" failure.
//
// Exits non-zero when the graph is broken so CI can gate on it; an earlier
// version only printed, which meant a green CI run could still be sitting on a
// broken resolution graph.
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { resolve, sep } from "node:path";

const base = resolve("node_modules/@midnight-ntwrk/testkit-js-stable/node_modules/@midnight-ntwrk");
if (!existsSync(base)) {
  console.error(`BLOCKER: stable testkit tree not found at ${base} — run \`npm ci\` first.`);
  process.exit(1);
}
const deps = ["@midnight-ntwrk/compact-runtime", "@midnight-ntwrk/onchain-runtime-v3", "@midnight-ntwrk/compact-js"];
let issues = 0;

for (const pkg of readdirSync(base)) {
  const pj = resolve(base, pkg, "package.json");
  if (!existsSync(pj)) continue;
  const r = createRequire(pj);
  for (const dep of deps) {
    try {
      const resolved = r.resolve(dep);
      const isNested = resolved.includes(`${sep}testkit-js-stable${sep}`);
      if (!isNested) {
        console.log(`TOP-LEVEL RESOLUTION: ${pkg} -> ${dep} = ${resolved}`);
        issues++;
      }
    } catch {
      /* not a dependency of this package */
    }
  }
}
if (issues === 0) {
  console.log("OK: all stable-stack runtime resolutions stay nested (or unused)");
} else {
  console.error(`FAIL: ${issues} v9-era top-level resolution(s) leaked into the v8-era stable stack.`);
  process.exit(1);
}
