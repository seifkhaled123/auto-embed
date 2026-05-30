import { describe, expect, it } from "vitest";
import { maskKey, maskUrl } from "../src/config/mask.js";

describe("maskKey", () => {
  it("returns (unset) for empty/undefined", () => {
    expect(maskKey(undefined)).toBe("(unset)");
    expect(maskKey("")).toBe("(unset)");
  });

  it("returns *** for short keys", () => {
    expect(maskKey("short")).toBe("***");
    expect(maskKey("12345678")).toBe("***");
  });

  it("shows first 4 and last 4 for normal keys", () => {
    expect(maskKey("sk-abcdef1234567890")).toBe("sk-a…7890");
  });

  it("does not leak the middle of the key", () => {
    const masked = maskKey("sk-secret-middle-xyz1234");
    expect(masked).not.toContain("secret");
    expect(masked).not.toContain("middle");
  });
});

describe("maskUrl", () => {
  it("returns (unset) for empty/undefined", () => {
    expect(maskUrl(undefined)).toBe("(unset)");
    expect(maskUrl("")).toBe("(unset)");
  });

  it("masks password in postgres URL", () => {
    const masked = maskUrl("postgres://alice:s3cret@db.example.com:5432/app");
    expect(masked).not.toContain("s3cret");
    expect(masked).toContain("***");
    expect(masked).toContain("db.example.com");
  });

  it("partially masks long usernames", () => {
    const masked = maskUrl("postgres://verylongname:pw@host/db");
    expect(masked).not.toContain("verylongname");
    expect(masked).toContain("***");
  });

  it("leaves URLs without credentials alone", () => {
    expect(maskUrl("http://localhost:8000")).toContain("localhost");
  });

  it("falls back to opaque mask for non-URL strings", () => {
    const masked = maskUrl("not-a-url-but-long-enough");
    expect(masked).not.toContain("a-url-but");
  });
});
