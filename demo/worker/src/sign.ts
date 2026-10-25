// HMAC signing shared with the voice server (DEMO_HMAC_SECRET):
// - tickets: the browser gets one per session and hands it to the voice server;
// - requests: the voice server signs its calls to /internal/*.
// The Python side is app/demo/signing.py; both must agree byte for byte.

const enc = new TextEncoder();

/** Seconds a ticket stays valid. */
export const TICKET_TTL = 60;
/** Seconds a signed request's timestamp may differ from ours. */
export const REQUEST_SKEW = 60;

/**
 * Makes a ticket for a session.
 * Args: secret — DEMO_HMAC_SECRET; sessionId — the session; now — unix ms.
 * Returns: "<base64url payload>.<hex signature>", payload {sid, exp} with exp in unix seconds.
 */
export async function makeTicket(secret: string, sessionId: string, now: number): Promise<string> {
  const payload = b64url(JSON.stringify({ sid: sessionId, exp: Math.floor(now / 1000) + TICKET_TTL }));
  return `${payload}.${await sign(secret, payload)}`;
}

/**
 * Checks a ticket's signature and expiry.
 * Args: secret — DEMO_HMAC_SECRET; ticket — from the browser, via the voice server; now — unix ms.
 * Returns: the session ID, or null if the ticket is forged, malformed or expired.
 */
export async function readTicket(secret: string, ticket: unknown, now: number): Promise<string | null> {
  if (typeof ticket !== "string" || ticket.length > 1024) return null;
  const [payload, sig, extra] = ticket.split(".");
  if (!payload || !sig || extra !== undefined || !(await verify(secret, payload, sig))) return null;
  try {
    const { sid, exp } = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof sid !== "string" || typeof exp !== "number" || exp * 1000 < now) return null;
    return sid;
  } catch {
    return null;
  }
}

/**
 * Signs a request body for /internal/*.
 * Args: secret — DEMO_HMAC_SECRET; body — the exact body text; now — unix ms.
 * Returns: the headers to send.
 */
export async function signRequest(secret: string, body: string, now: number): Promise<Record<string, string>> {
  const ts = String(Math.floor(now / 1000));
  return { "x-offhook-timestamp": ts, "x-offhook-signature": await sign(secret, `${ts}.${body}`) };
}

/**
 * Checks a signed /internal/* request.
 * Args: secret — DEMO_HMAC_SECRET; headers — the request's headers; body — its exact text; now — unix ms.
 * Returns: true if the signature matches and the timestamp is within REQUEST_SKEW.
 */
export async function verifyRequest(secret: string, headers: Headers, body: string, now: number): Promise<boolean> {
  const ts = headers.get("x-offhook-timestamp");
  const sig = headers.get("x-offhook-signature");
  if (!ts || !sig || !/^\d{1,12}$/.test(ts)) return false;
  if (Math.abs(Number(ts) - now / 1000) > REQUEST_SKEW) return false;
  return verify(secret, `${ts}.${body}`, sig);
}

/** Returns the hex HMAC-SHA256 of `message`. */
async function sign(secret: string, message: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await key(secret), enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Checks a hex signature in constant time (crypto.subtle.verify). */
async function verify(secret: string, message: string, hex: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(hex)) return false;
  const bytes = new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));
  return crypto.subtle.verify("HMAC", await key(secret), bytes, enc.encode(message));
}

/** Imports the secret as an HMAC-SHA256 key. */
function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** Base64url without padding. */
function b64url(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
