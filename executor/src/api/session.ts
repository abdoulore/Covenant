/**
 * Operator session (Frontend Part B, single-operator auth). See docs/DECISIONS.md D12.
 *
 * v1 auth is deliberately minimal and honestly secure for ONE operator: an env-configured secret is
 * exchanged for a signed, expiring session token carried in an HttpOnly cookie. There is no user
 * store and no OAuth, because there is one operator. Every write route verifies the token; read
 * routes never do.
 *
 * The token is stateless: `base64url(payload).hmac`, where the HMAC is over the payload with a key
 * derived from the operator secret. No server-side session table to fall out of sync, and rotating
 * the operator secret invalidates every outstanding token by construction.
 *
 * This module is pure crypto over node:crypto. It touches no network and no chain, so it is fully
 * unit-tested without either. It never logs or returns the operator secret.
 */
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

interface TokenPayload {
  /** Issued-at, epoch ms. */
  iat: number;
  /** Expiry, epoch ms. */
  exp: number;
  /** Random nonce, so two tokens issued in the same millisecond still differ. */
  n: string;
}

/** The signing key is derived from the operator secret, never the secret itself. */
function signingKey(operatorSecret: string): Buffer {
  return createHmac("sha256", "covenant.session.v1").update(operatorSecret).digest();
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function sign(payloadB64: string, key: Buffer): string {
  return b64url(createHmac("sha256", key).update(payloadB64).digest());
}

/** Constant-time string comparison that never throws on length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** True when the presented secret matches the configured operator secret, in constant time. */
export function checkOperatorSecret(presented: string, operatorSecret: string): boolean {
  return safeEqual(presented, operatorSecret);
}

/** Issue a signed session token valid for `ttlMs` from `now`. */
export function issueToken(operatorSecret: string, now = Date.now(), ttlMs = DEFAULT_TTL_MS): string {
  const payload: TokenPayload = { iat: now, exp: now + ttlMs, n: randomBytes(9).toString("hex") };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload)));
  return `${payloadB64}.${sign(payloadB64, signingKey(operatorSecret))}`;
}

/** Verify a session token's signature and expiry. Returns true only for a well-formed, live token. */
export function verifyToken(operatorSecret: string, token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return false;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = sign(payloadB64, signingKey(operatorSecret));
  if (!safeEqual(sig, expected)) return false;

  let payload: TokenPayload;
  try {
    payload = JSON.parse(fromB64url(payloadB64).toString("utf8"));
  } catch {
    return false;
  }
  if (typeof payload.exp !== "number") return false;
  return now < payload.exp;
}
