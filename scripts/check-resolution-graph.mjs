// One-off: verify no stable-stack package resolves a runtime class-provider to
// the TOP-LEVEL (beta.8-era) copy — that split caused the live
// "expected instance of ContractMaintenanceAuthority" failure.
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { resolve, sep } from "node:path";

const base = resolve("node_modules/@midnight-ntwrk/testkit-js-stable/node_modules/@midnight-ntwrk");
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
console.log(issues === 0 ? "OK: all stable-stack runtime resolutions stay nested (or unused)" : `${issues} issue(s)`);
