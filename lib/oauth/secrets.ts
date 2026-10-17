import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Codes and tokens are opaque random strings. Only their SHA-256 hashes are
 * stored, so a database leak hands out nothing usable, and no signing key is
 * needed. The prefix only makes a leaked token recognisable in logs.
 */
export function generateSecret(prefix: "orc" | "ora" | "orr"): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

// RFC 7636: 43 to 128 characters from the unreserved set.
const CODE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

export function isS256Challenge(value: string): boolean {
  return S256_CHALLENGE.test(value);
}

export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!CODE_VERIFIER.test(verifier)) return false;
  const computed = Buffer.from(
    createHash("sha256").update(verifier).digest("base64url")
  );
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}
