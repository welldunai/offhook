// Cloudflare Turnstile: proves a person (not a script) is behind a plan, call or signup.

/**
 * Checks a Turnstile token with Cloudflare.
 * Args: token — from the widget on the site; secret — TURNSTILE_SECRET_KEY;
 *   ip — the visitor's IP, if known; doFetch — tests pass a fake.
 * Returns: true if Cloudflare accepted the token. Network errors count as false.
 */
export async function verifyTurnstile(
  token: unknown,
  secret: string,
  ip: string | null,
  doFetch: typeof fetch = fetch,
): Promise<boolean> {
  if (typeof token !== "string" || !token || token.length > 2048) return false;
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  try {
    const res = await doFetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return false;
    return ((await res.json()) as { success?: boolean }).success === true;
  } catch {
    return false;
  }
}
