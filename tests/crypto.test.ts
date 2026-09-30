import { describe, expect, it } from "vitest";
import { digestComment, fromHex, generateSecret, isBlank, toHex } from "../src/lib/crypto";

describe("crypto helpers", () => {
  it("generates a 32-byte secret each time, and does not repeat trivially", () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a).toHaveLength(32);
    expect(b).toHaveLength(32);
    expect(toHex(a)).not.toBe(toHex(b));
  });

  it("round-trips bytes through hex without loss", () => {
    const original = generateSecret();
    const restored = fromHex(toHex(original));
    expect(Array.from(restored)).toEqual(Array.from(original));
  });

  it("rejects malformed hex input rather than silently truncating it", () => {
    expect(() => fromHex("not-hex")).toThrow();
    expect(() => fromHex("ab")).toThrow();
  });

  it("produces a deterministic 32-byte digest for the same comment", async () => {
    const a = await digestComment("The onboarding docs were confusing.");
    const b = await digestComment("The onboarding docs were confusing.");
    expect(a).toHaveLength(32);
    expect(toHex(a)).toBe(toHex(b));
  });

  it("produces different digests for different comments", async () => {
    const a = await digestComment("Great experience overall.");
    const b = await digestComment("Great experience, overall.");
    expect(toHex(a)).not.toBe(toHex(b));
  });

  it("treats whitespace-only comments as blank", () => {
    expect(isBlank("   ")).toBe(true);
    expect(isBlank("")).toBe(true);
    expect(isBlank("hi")).toBe(false);
  });
});
