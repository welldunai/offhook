// Who is this visitor, for limits? A salted hash of their IP and of a first-party cookie,
// both rotating daily (the date is in the hash), so raw IPs are never stored and
// yesterday's keys can't be linked to today's.

export const COOKIE = "oh_vid";
const ID = /^[0-9a-f-]{36}$/;

export interface Visitor {
  keys: string[]; // hashed, e.g. ["ip:3f…", "id:a1…"]
  setCookie?: string; // a Set-Cookie value when the visitor had no valid cookie
}

/**
 * Builds the visitor's limit keys.
 * Args: request — the incoming request; salt — VISITOR_HASH_SALT; day — "YYYY-MM-DD" (UTC).
 * Returns: the hashed keys, and a cookie to set if the visitor didn't have one.
 */
export async function identify(request: Request, salt: string, day: string): Promise<Visitor> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  let id = readCookie(request.headers.get("cookie"), COOKIE);
  let setCookie: string | undefined;
  if (!id || !ID.test(id)) {
    id = crypto.randomUUID();
    setCookie = `${COOKIE}=${id}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`;
  }
  return {
    keys: [`ip:${await hash(salt, day, "ip", ip)}`, `id:${await hash(salt, day, "id", id)}`],
    setCookie,
  };
}

/** Returns today's date in UTC as "YYYY-MM-DD". */
export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Returns the seconds until the next UTC midnight, when daily limits reset. */
export function secondsToReset(now = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.ceil((next - now.getTime()) / 1000);
}

/**
 * Args: header — a Cookie header (or null); name — the cookie to find.
 * Returns: its value, or null.
 */
function readCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

/** Returns the first 32 hex characters of SHA-256 over the parts, joined with "|". */
async function hash(...parts: string[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("|")));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
