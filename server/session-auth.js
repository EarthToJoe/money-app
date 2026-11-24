// Finch's sign-in: one password, then a long-lived cookie.
//
// Once Finch is reachable at a public address (finch.hughesnode.com) and holds
// your synced data, anyone who finds the address must not be able to read it.
// FINCH_PASSWORD in .env is the one secret. Signing in with it sets an
// HttpOnly cookie that lasts a year, so the phone's home-screen app stays
// signed in instead of asking every launch.
//
// Why a cookie and not the tunnel's Basic auth: iPhone home-screen apps don't
// reliably keep Basic-auth credentials between launches, and a browser prompt
// can't be styled or shown inside the app. The tunnel gate in
// server/tunnel-auth.js still works exactly as before.
//
// The cookie is `<expiry>.<signature>`, signed with HMAC-SHA256 under a key
// derived from FINCH_SESSION_SECRET (or, if unset, from FINCH_PASSWORD). With
// the fallback, changing the password signs every device out, which is what
// you want after a password leak. Nothing about the session is stored
// server-side, so there's nothing to clean up.
//
// Requests from the machine Finch runs on (see isLocalRequest) never need to
// sign in, so `npm run dev` on your Mac behaves as it always has.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { checkBasicAuth, isLocalRequest } from './tunnel-auth.js';

export const COOKIE_NAME = 'finch_session';
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** The sign-in password, or '' when none is set. */
export function readAppPassword() {
  return clean(process.env.FINCH_PASSWORD);
}

function signingKey(password) {
  const secret = clean(process.env.FINCH_SESSION_SECRET) || `finch-session:${password}`;
  return createHash('sha256').update(secret, 'utf8').digest();
}

function sign(payload, password) {
  return createHmac('sha256', signingKey(password)).update(payload, 'utf8').digest('base64url');
}

function sameString(a, b) {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

export function passwordMatches(candidate, password) {
  if (!password || typeof candidate !== 'string') return false;
  return sameString(candidate, password);
}

export function makeSessionToken(password, now = Date.now()) {
  const expires = String(Math.floor(now / 1000) + ONE_YEAR_SECONDS);
  return `${expires}.${sign(expires, password)}`;
}

export function isValidSessionToken(token, password, now = Date.now()) {
  if (!password || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const expires = token.slice(0, dot);
  if (!/^\d+$/.test(expires) || Number(expires) * 1000 <= now) return false;
  return sameString(token.slice(dot + 1), sign(expires, password));
}

/** The value of one cookie from a Cookie header, or ''. */
export function readCookie(header, name) {
  if (typeof header !== 'string') return '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return '';
      }
    }
  }
  return '';
}

/** Behind nginx/Caddy the socket is plain http; the proxy says what the browser used. */
function isHttps(req) {
  if (req.secure) return true;
  const proto = req.headers?.['x-forwarded-proto'];
  return typeof proto === 'string' && proto.split(',')[0].trim() === 'https';
}

export function sessionCookie(req, token) {
  const parts = [`${COOKIE_NAME}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (token) parts.push(`Max-Age=${ONE_YEAR_SECONDS}`);
  else parts.push('Max-Age=0');
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Who is asking? 'local' (this machine), 'session' (signed in), 'tunnel'
 * (presented the tunnel password), or null.
 */
export function identify(req, { appPassword, tunnelPassword }) {
  if (isLocalRequest(req)) return 'local';
  if (isValidSessionToken(readCookie(req.headers?.cookie, COOKIE_NAME), appPassword)) return 'session';
  if (tunnelPassword && checkBasicAuth(req.headers?.authorization, tunnelPassword)) return 'tunnel';
  return null;
}
