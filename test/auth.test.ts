import { describe, expect, it } from "vitest";
import { checkBearer, generateToken } from "../src/mcp/auth";

describe("generateToken", () => {
  it("returns long, url-safe, unique tokens", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });
});

describe("checkBearer", () => {
  const token = "s3cret-token";

  it("accepts the exact bearer token", () => {
    expect(checkBearer(`Bearer ${token}`, token)).toBe(true);
  });

  it("rejects missing, wrong, malformed and empty credentials", () => {
    expect(checkBearer(undefined, token)).toBe(false);
    expect(checkBearer("", token)).toBe(false);
    expect(checkBearer("Bearer wrong", token)).toBe(false);
    expect(checkBearer(`Bearer ${token}x`, token)).toBe(false);
    expect(checkBearer(token, token)).toBe(false);
    expect(checkBearer(`Basic ${token}`, token)).toBe(false);
    expect(checkBearer(`Bearer ${token} extra`, token)).toBe(false);
    expect(checkBearer("Bearer ", token)).toBe(false);
    expect(checkBearer("Bearer x", "")).toBe(false);
  });
});
