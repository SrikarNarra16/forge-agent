import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Bearer-token generation and verification for the MCP server. The token is random per
 * activation, lives only in memory and is handed to TrueForge as a header secret.
 */
export type BearerToken = string;

export function generateToken(): BearerToken {
  return randomBytes(32).toString("base64url");
}

/** True only for an `Authorization: Bearer <token>` header whose token equals `token` (constant-time). */
export function checkBearer(header: string | undefined, token: BearerToken): boolean {
  if (!header || token.length === 0) return false;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  if (!match?.[1]) return false;
  // Hash both sides so the comparison is constant-time and length-independent.
  const given = createHash("sha256").update(match[1]).digest();
  const expected = createHash("sha256").update(token).digest();
  return timingSafeEqual(given, expected);
}
