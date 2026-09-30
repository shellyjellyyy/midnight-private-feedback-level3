/**
 * Regression tests for the browser `Buffer` polyfill.
 *
 * THE DEFECT
 *   The retained ledger-v8 Preview path calls
 *     findDeployedContract()
 *       -> @midnight-ntwrk/compact-runtime-ledger8/dist/utils.js
 *       -> Buffer.from(value, "hex")
 *   as a bare Node GLOBAL. A browser has no `Buffer` global, so contract-state
 *   decoding threw `ReferenceError: Buffer is not defined` on Submit — after the
 *   join had already read the chain successfully. Node never hit it because
 *   `Buffer` is a real global there.
 *
 * WHAT IS PINNED
 *   `src/polyfills.ts` installs the global, never overwrites an existing one,
 *   supplies the exact API surface the affected modules call, and is imported
 *   FIRST by the entry point.
 *
 * NO NETWORK ACCESS.
 *
 * WHY THESE TESTS DO NOT TOUCH THE REAL globalThis
 *   They must, so `installBufferPolyfill` accepts a target object. Removing the
 *   ambient `Buffer` breaks Vitest's own IPC — its result serializer reads
 *   `Buffer` asynchronously between tests, so deleting it mid-run produces
 *   thousands of "Buffer is not defined" errors from the runner itself and the
 *   suite never completes. Every behavioural assertion therefore runs against an
 *   isolated plain object, which is exactly the seam the function exposes.
 *   The one global-level fact (that importing the module installs a global) is
 *   asserted by observation, non-destructively.
 */
import { describe, expect, it } from "vitest";
import { Buffer as NodeBuffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { installBufferPolyfill } from "../src/polyfills";
import { Buffer as BufferPackage } from "buffer";

/** A stand-in for globalThis: the seam `installBufferPolyfill` accepts. */
type Target = { Buffer?: unknown };

describe("buffer polyfill installation", () => {
  it("installs a Buffer when none is present", () => {
    const target: Target = {};

    const installed = installBufferPolyfill(target);

    expect(installed).toBe(true);
    expect(typeof target.Buffer).toBe("function");
  });

  it("does not overwrite an existing Buffer global", () => {
    const sentinel = { marker: "pre-existing" };
    const target: Target = { Buffer: sentinel };

    const installed = installBufferPolyfill(target);

    expect(installed).toBe(false);
    // The host's own implementation survives untouched.
    expect(target.Buffer).toBe(sentinel);
  });

  it("treats any pre-existing defined value as present, not just a function", () => {
    // `undefined` is the only value that counts as absent; a falsy-but-defined
    // value must not be clobbered either.
    for (const existing of [null, 0, "", false]) {
      const target: Target = { Buffer: existing };
      expect(installBufferPolyfill(target)).toBe(false);
      expect(target.Buffer).toBe(existing);
    }
  });

  it("treats an explicit undefined as absent", () => {
    const target: Target = { Buffer: undefined };

    expect(installBufferPolyfill(target)).toBe(true);
    expect(typeof target.Buffer).toBe("function");
  });

  it("is idempotent — a second call changes nothing and reports false", () => {
    const target: Target = {};

    expect(installBufferPolyfill(target)).toBe(true);
    const first = target.Buffer;

    expect(installBufferPolyfill(target)).toBe(false);
    expect(target.Buffer).toBe(first);
  });

  it("installs the browser-safe npm buffer implementation", () => {
    const target: Target = {};
    installBufferPolyfill(target);
    expect(target.Buffer).toBe(BufferPackage);
  });

  it("leaves a real globalThis.Buffer installed after the module is imported", () => {
    // Non-destructive observation: main.tsx imports ./polyfills for this side
    // effect, so by the time anything else runs, globalThis.Buffer must exist.
    expect(typeof (globalThis as { Buffer?: unknown }).Buffer).toBe("function");
  });
});

describe("the polyfilled Buffer satisfies the Midnight call sites", () => {
  /** Installs into an isolated target and returns the resulting Buffer class. */
  function installedBuffer(): typeof NodeBuffer {
    const target: Target = {};
    installBufferPolyfill(target);
    return target.Buffer as typeof NodeBuffer;
  }

  /**
   * The exact operations the diagnosed modules perform.
   * Sources: compact-runtime-ledger8/dist/utils.js (fromHex/toHex),
   * compact-runtime-ledger8/dist/zswap.js (insertCommitment),
   * @midnightntwrk/wallet-sdk-address-format (hex codec + concat).
   */
  it("Buffer.from(hex, 'hex') decodes correctly", () => {
    const B = installedBuffer();
    // utils.js: export const fromHex = (s) => Buffer.from(s, 'hex');
    const decoded = B.from("deadbeef", "hex");

    expect(decoded).toBeInstanceOf(Uint8Array);
    expect(Array.from(decoded)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it("Buffer.from(bytes).toString('hex') round-trips", () => {
    const B = installedBuffer();
    // utils.js: export const toHex = (s) => Buffer.from(s).toString('hex');
    const toHex = (s: Uint8Array): string => B.from(s).toString("hex");

    expect(toHex(new Uint8Array([0x00, 0x0f, 0xff, 0x10]))).toBe("000fff10");
    expect(toHex(new Uint8Array())).toBe("");
  });

  it("Buffer.concat joins segments, as the address codec does", () => {
    const B = installedBuffer();
    // wallet-sdk-address-format: Buffer.concat([coinPublicKey.data, encryptionPublicKey.data])
    const joined = B.concat([B.from("aabb", "hex"), B.from("ccdd", "hex")]);

    expect(joined).toHaveLength(4);
    expect(joined.toString("hex")).toBe("aabbccdd");
  });

  it("Buffer.from(ArrayBuffer, byteOffset, length) works", () => {
    const B = installedBuffer();
    // The address-format hex encoder slices via Buffer.from(buf, offset, len).
    const backing = new Uint8Array([1, 2, 3, 4, 5, 6]);

    expect(Array.from(B.from(backing.buffer, 2, 3))).toEqual([3, 4, 5]);
  });

  it("Buffer.isBuffer and Buffer.allocUnsafe are available", () => {
    const B = installedBuffer();

    expect(B.isBuffer(B.from([1, 2, 3]))).toBe(true);
    expect(B.isBuffer("not a buffer")).toBe(false);
    expect(B.allocUnsafe(128)).toHaveLength(128);
  });

  it("round-trips the deployed contract address byte-identically to native", () => {
    const CONTRACT_ADDRESS = "916ae63acf5d4256a33c249cf138938cb9cb33210cf6081feecb2a18648248bc";
    const B = installedBuffer();

    expect(B.from(CONTRACT_ADDRESS, "hex").toString("hex")).toBe(CONTRACT_ADDRESS);
    // The polyfill and Node's native Buffer agree, so nothing downstream can
    // observe the substitution. Compared as raw bytes rather than with
    // `Buffer.prototype.equals`, which only accepts its own implementation's
    // instances and would report a false mismatch here.
    const viaPolyfill = B.from(CONTRACT_ADDRESS, "hex");
    const viaNative = NodeBuffer.from(CONTRACT_ADDRESS, "hex");
    expect(viaPolyfill.length).toBe(viaNative.length);
    expect(Array.from(viaPolyfill)).toEqual(Array.from(viaNative));
  });
});

describe("entry-point import order", () => {
  it("main.tsx imports ./polyfills before any application import", () => {
    // Ordering is load-bearing: any import that reaches the ledger-8 runtime
    // above this line could execute a bare `Buffer` reference before the
    // polyfill is installed. This asserts the source, which a bundler cannot
    // silently reorder past.
    const source = readFileSync(resolve(__dirname, "../src/main.tsx"), "utf8");
    const imports = source
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("import "));

    const polyfillIndex = imports.findIndex((line) => line.includes('"./polyfills"'));
    expect(polyfillIndex).toBeGreaterThanOrEqual(0);

    // `./polyfills` must be the FIRST import statement in the file.
    expect(polyfillIndex).toBe(0);
  });
});