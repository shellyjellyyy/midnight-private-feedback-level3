/**
 * Cross-platform path handling for scripts/compile-contract.mjs.
 *
 * WHY THIS FILE EXISTS
 * The compile script used to run `toWslPath()` on the source, output and repo
 * paths UNCONDITIONALLY. That is correct for the Windows/WSL development box,
 * where the Compact compiler is invoked through `wsl -e bash -lc` and therefore
 * needs a `/mnt/<drive>/...` path — but it is wrong on a Linux CI runner,
 * where `path.resolve()` already returns a POSIX path and the compiler is
 * already Linux-side. On GitHub Actions the unconditional translation threw
 *
 *   Error: cannot translate to a WSL path:
 *   /home/runner/work/.../contracts/feedback.compact
 *
 * and aborted both `npm run compile:v9` and `npm run compile:v8`, which every
 * downstream CI step depends on.
 *
 * The rule is stated once, here, and is deliberately narrow:
 *
 *   - a path that is ALREADY POSIX absolute is passed through unchanged,
 *     because it is already valid for a Linux-hosted compiler;
 *   - a WINDOWS path is translated to its `/mnt/<drive>/...` WSL equivalent,
 *     because that is the only form a compiler inside WSL understands;
 *   - anything else, or a Windows path on a non-Windows platform, is a hard
 *     error rather than a silent guess.
 *
 * Nothing here is GitHub Actions specific and nothing hardcodes a runner
 * path: the decision is driven only by the shape of the path and by
 * `process.platform`.
 *
 * This module is PURE. It performs no I/O, spawns nothing, and never calls
 * process.exit. `platform` is injectable so the Windows branch can be tested
 * from a Linux/macOS test run and vice versa.
 */

/** True for an already-absolute POSIX path, which needs no translation. */
export function isPosixAbsolutePath(p) {
  return typeof p === "string" && p.startsWith("/");
}

/** True for an absolute Windows path (`C:\...`, `C:/...` or a UNC `\\host`). */
export function isWindowsAbsolutePath(p) {
  if (typeof p !== "string" || p.length === 0) return false;
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

/** True when the Compact compiler must be reached through WSL. */
export function compilerRunsInWsl(platform = process.platform) {
  return platform === "win32";
}

/**
 * Translate an absolute path into the form the Compact compiler expects.
 *
 * @param {string} targetPath absolute path as produced by path.resolve()
 * @param {string} [platform] defaults to process.platform
 * @returns {string} the path to hand to the compiler
 * @throws {Error} on a relative path, an unrecognised shape, or a Windows path
 *   presented to a non-Windows platform
 */
export function toCompilerPath(targetPath, platform = process.platform) {
  if (typeof targetPath !== "string" || targetPath.length === 0) {
    throw new Error(`cannot build a compiler path from: ${String(targetPath)}`);
  }

  // Already POSIX: Linux/macOS CI, or a Windows process handed a WSL path.
  // The compiler is Linux-side, so this must survive byte-for-byte.
  if (isPosixAbsolutePath(targetPath)) return targetPath;

  if (!isWindowsAbsolutePath(targetPath)) {
    throw new Error(
      `cannot build a compiler path: ${targetPath} is neither an absolute POSIX path nor an absolute Windows path`,
    );
  }

  if (!compilerRunsInWsl(platform)) {
    throw new Error(
      `cannot build a compiler path: ${targetPath} is a Windows path but the compiler runs on ${platform}, not inside WSL`,
    );
  }

  const m = targetPath.replace(/\\/g, "/").match(/^([A-Za-z]):\/(.*)$/);
  if (!m) {
    throw new Error(`cannot translate to a WSL path: ${targetPath}`);
  }
  return `/mnt/${m[1].toLowerCase()}/${m[2]}`;
}