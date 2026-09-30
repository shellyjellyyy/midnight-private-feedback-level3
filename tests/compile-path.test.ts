import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
// @ts-ignore - plain ESM helper module, deliberately untyped so it stays importable
// from the deploy script without a build step.
import {
  compilerRunsInWsl,
  isPosixAbsolutePath,
  isWindowsAbsolutePath,
  toCompilerPath,
} from "../scripts/lib-compiler-path.mjs";

/**
 * These tests exercise the path translation used by
 * scripts/compile-contract.mjs. They are OFFLINE and platform-independent: the
 * `platform` argument is injected, so the Windows branch is verified even when
 * the suite runs on Linux CI, and the Linux branch is verified on a Windows dev
 * box. Nothing here spawns a compiler, touches WSL or touches the network.
 *
 * The regression being locked down is real: the compile script used to run a
 * Windows-only translation on every platform, so on the ubuntu-latest runner
 * `npm run compile:v9` aborted with
 *
 *   Error: cannot translate to a WSL path:
 *   /home/runner/work/.../contracts/feedback.compact
 */

// Resolved from this file, not the CWD, so the test does not depend on where
// vitest was invoked from.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMPILE_SCRIPT = resolve(REPO_ROOT, "scripts/compile-contract.mjs");

/** The real failure reported by the first GitHub Actions run. */
const CI_SOURCE_PATH =
  "/home/runner/work/midnight-private-feedback-level3/midnight-private-feedback-level3/contracts/feedback.compact";
/** The Windows-style input that must keep following the Windows -> WSL path. */
const WINDOWS_SOURCE_PATH = "C:\\foo\\bar\\contracts\\feedback.compact";

describe("toCompilerPath — POSIX paths are never sent through WSL translation", () => {
  it("returns the exact GitHub Actions CI path unchanged on linux", () => {
    expect(toCompilerPath(CI_SOURCE_PATH, "linux")).toBe(CI_SOURCE_PATH);
  });

  it("returns the exact GitHub Actions CI path unchanged on darwin", () => {
    expect(toCompilerPath(CI_SOURCE_PATH, "darwin")).toBe(CI_SOURCE_PATH);
  });

  it("returns a POSIX path unchanged even when the host platform is win32", () => {
    // A Windows process handed a WSL path must not try to translate it again.
    expect(toCompilerPath("/mnt/c/dev/project/contracts/feedback.compact", "win32")).toBe(
      "/mnt/c/dev/project/contracts/feedback.compact",
    );
  });

  it("preserves a POSIX path containing spaces and dots without mangling it", () => {
    const posix = "/home/runner/work/my project/contracts/feedback.compact";
    expect(toCompilerPath(posix, "linux")).toBe(posix);
  });

  it("never produces a /mnt/<drive> path from a POSIX input", () => {
    expect(toCompilerPath(CI_SOURCE_PATH, "linux")).not.toMatch(/^\/mnt\/[a-z]\//);
  });

  it("does not throw for the CI path, which was the failing input", () => {
    // The pre-fix helper threw here; that throw is the bug under test.
    expect(() => toCompilerPath(CI_SOURCE_PATH, "linux")).not.toThrow();
  });
});

describe("toCompilerPath — Windows paths still convert to WSL", () => {
  it("converts a Windows-style contract path on win32", () => {
    expect(toCompilerPath(WINDOWS_SOURCE_PATH, "win32")).toBe("/mnt/c/foo/bar/contracts/feedback.compact");
  });

  it("lowercases the drive letter, as /mnt/ requires", () => {
    expect(toCompilerPath("D:\\Work\\contracts\\feedback.compact", "win32")).toBe(
      "/mnt/d/Work/contracts/feedback.compact",
    );
  });

  it("converts a Windows path that already uses forward slashes", () => {
    expect(toCompilerPath("C:/Users/dev/project/contracts/feedback.compact", "win32")).toBe(
      "/mnt/c/Users/dev/project/contracts/feedback.compact",
    );
  });

  it("converts the repo root and the output dir the same way", () => {
    expect(toCompilerPath("C:\\foo\\bar", "win32")).toBe("/mnt/c/foo/bar");
    expect(toCompilerPath("C:\\foo\\bar\\managed\\feedback", "win32")).toBe(
      "/mnt/c/foo/bar/managed/feedback",
    );
    expect(toCompilerPath("C:\\foo\\bar\\managed\\feedback-v8", "win32")).toBe(
      "/mnt/c/foo/bar/managed/feedback-v8",
    );
  });

  it("preserves a Windows path containing spaces", () => {
    expect(toCompilerPath("C:\\my project\\contracts\\feedback.compact", "win32")).toBe(
      "/mnt/c/my project/contracts/feedback.compact",
    );
  });
});

describe("toCompilerPath — anything else fails loudly instead of guessing", () => {
  it("rejects a relative path", () => {
    expect(() => toCompilerPath("contracts/feedback.compact", "linux")).toThrow(
      /neither an absolute POSIX path nor an absolute Windows path/,
    );
  });

  it("rejects an empty path", () => {
    expect(() => toCompilerPath("", "linux")).toThrow(/cannot build a compiler path from/);
  });

  it("rejects a Windows path presented to a non-Windows platform", () => {
    expect(() => toCompilerPath(WINDOWS_SOURCE_PATH, "linux")).toThrow(
      /Windows path but the compiler runs on linux/,
    );
  });

  it("rejects a UNC path, which has no WSL equivalent", () => {
    expect(() => toCompilerPath("\\\\server\\share\\feedback.compact", "win32")).toThrow(
      /cannot translate to a WSL path/,
    );
  });
});

describe("path shape predicates", () => {
  it("recognises POSIX absolute paths", () => {
    expect(isPosixAbsolutePath(CI_SOURCE_PATH)).toBe(true);
    expect(isPosixAbsolutePath(WINDOWS_SOURCE_PATH)).toBe(false);
    expect(isPosixAbsolutePath("contracts/feedback.compact")).toBe(false);
    expect(isPosixAbsolutePath(undefined)).toBe(false);
  });

  it("recognises Windows absolute paths", () => {
    expect(isWindowsAbsolutePath(WINDOWS_SOURCE_PATH)).toBe(true);
    expect(isWindowsAbsolutePath("C:/foo/bar")).toBe(true);
    expect(isWindowsAbsolutePath(CI_SOURCE_PATH)).toBe(false);
    expect(isWindowsAbsolutePath("feedback.compact")).toBe(false);
  });
});

describe("compilerRunsInWsl — the WSL requirement is preserved, not removed", () => {
  it("is true only on win32", () => {
    expect(compilerRunsInWsl("win32")).toBe(true);
    expect(compilerRunsInWsl("linux")).toBe(false);
    expect(compilerRunsInWsl("darwin")).toBe(false);
  });

  it("defaults to the real process.platform", () => {
    expect(compilerRunsInWsl()).toBe(process.platform === "win32");
  });
});

describe("scripts/compile-contract.mjs actually uses the cross-platform helper", () => {
  const source = readFileSync(COMPILE_SCRIPT, "utf8");

  it("imports toCompilerPath from the shared helper", () => {
    expect(source).toContain('from "./lib-compiler-path.mjs"');
    expect(source).toContain("toCompilerPath");
  });

  it("no longer contains the Windows-only toWslPath translation", () => {
    expect(source).not.toContain("toWslPath");
    expect(source).not.toContain("cannot translate to a WSL path: ${");
  });

  it("routes the WSL wrapping decision through compilerRunsInWsl", () => {
    expect(source).toContain("compilerRunsInWsl()");
    expect(source).toContain("wsl -e bash -lc");
  });

  it("does not hardcode a CI runner path or a GitHub Actions special case", () => {
    expect(source).not.toContain("/home/runner");
    expect(source).not.toContain("process.env.GITHUB_ACTIONS");
    expect(source).not.toContain("process.env.CI");
    expect(source).not.toContain("RUNNER_OS");
  });

  it("still pins both compiler versions", () => {
    expect(source).toContain('v9: {\n    compiler: "0.34.0"');
    expect(source).toContain('v8: {\n    compiler: "0.31.1"');
    expect(source).toContain("compact compile +${era.compiler}");
  });
});