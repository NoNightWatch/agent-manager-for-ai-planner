/**
 * Minimal HS256 JWT verification using Node's built-in crypto module.
 * No external dependencies required.
 *
 * Supported claims:
 *   sub  (required) - token owner / tenant ID
 *   exp  (optional) - expiry as Unix seconds
 *   iat  (optional) - issued-at
 *   aud  (optional) - audience (matched against expectedAudience)
 *   tier_cap (optional) - model tier ceiling: 'cheap' | 'standard' | 'premium'
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export type JWTPayload = {
  sub: string;
  exp?: number;
  iat?: number;
  aud?: string | string[];
  tier_cap?: 'cheap' | 'standard' | 'premium';
  [key: string]: unknown;
};

const base64urlDecode = (s: string): string =>
  Buffer.from(s, 'base64url').toString('utf8');

/**
 * Returns true when the token string structurally looks like a JWT
 * (three base64url-encoded parts separated by dots).
 */
export const looksLikeJWT = (token: string): boolean => {
  const parts = token.split('.');
  return parts.length === 3 && parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p));
};

/**
 * Verifies an HS256 JWT.
 * Returns the decoded payload on success, or null on any failure
 * (bad signature, expired, wrong algorithm, audience mismatch, etc.).
 */
export const verifyJWT = (
  token: string,
  secret: string,
  expectedAudience?: string
): JWTPayload | null => {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  // Verify header declares HS256
  try {
    const header = JSON.parse(base64urlDecode(headerB64)) as Record<string, unknown>;
    if (header.alg !== 'HS256') return null;
  } catch {
    return null;
  }

  // Constant-time signature comparison to prevent timing attacks
  const expectedSig = createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  const providedSig = Buffer.from(sigB64, 'base64url');
  try {
    if (expectedSig.length !== providedSig.length || !timingSafeEqual(expectedSig, providedSig)) {
      return null;
    }
  } catch {
    return null;
  }

  // Parse and validate payload
  let payload: JWTPayload;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64)) as JWTPayload;
  } catch {
    return null;
  }

  if (!payload.sub || typeof payload.sub !== 'string') return null;

  // Expiry check
  if (payload.exp !== undefined && Date.now() / 1000 > payload.exp) return null;

  // Audience check
  if (expectedAudience !== undefined && payload.aud !== undefined) {
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(expectedAudience)) return null;
  }

  return payload;
};

/**
 * Sign a payload as an HS256 JWT. Useful for generating test tokens.
 */
export const signJWT = (payload: JWTPayload, secret: string): string => {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
};
