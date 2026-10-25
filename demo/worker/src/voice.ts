// Is the voice server (on the maintainer's machine, behind a Cloudflare Tunnel) up?
// Checked with a short timeout and cached briefly, so a sleeping laptop costs each
// visitor at most two seconds, and only every 30 seconds per Worker instance.

const TIMEOUT_MS = 2_000;
const CACHE_MS = 30_000;
let cache: { at: number; online: boolean } | null = null;

/**
 * Args: voiceUrl — the voice server's base URL (VOICE_URL); now — unix ms;
 *   doFetch — tests pass a fake.
 * Returns: true if GET /healthz answered 2xx recently.
 */
export async function voiceOnline(voiceUrl: string, now = Date.now(), doFetch: typeof fetch = fetch): Promise<boolean> {
  if (cache && now - cache.at < CACHE_MS) return cache.online;
  let online = false;
  try {
    const res = await doFetch(new URL("/healthz", voiceUrl).toString(), { signal: AbortSignal.timeout(TIMEOUT_MS) });
    online = res.ok;
  } catch {
    online = false;
  }
  cache = { at: now, online };
  return online;
}

/** Forgets the cached answer (tests). */
export function resetVoiceCache(): void {
  cache = null;
}

/**
 * Args: voiceUrl — the voice server's base URL.
 * Returns: the WebSocket URL the browser connects to, e.g. wss://voice.offhook.welldun.ai/ws.
 */
export function voiceSocketUrl(voiceUrl: string): string {
  const u = new URL("/ws", voiceUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
}
