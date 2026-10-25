// Small response helpers shared by the routes.

/** Returns `data` as a JSON response with `status`. */
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

/** A JSON error for the visitor: a machine-readable `error` and a sentence they can read. */
export function problem(error: string, message: string, status: number, extra: Record<string, unknown> = {}): Response {
  return json({ error, message, ...extra }, status);
}

/** Adds the visitor cookie to `res` when one needs setting; returns `res`. */
export function withCookie(res: Response, setCookie: string | undefined): Response {
  if (setCookie) res.headers.append("set-cookie", setCookie);
  return res;
}

/**
 * Reads a JSON object body, refusing anything over `maxBytes`.
 * Args: request — the incoming request; maxBytes — the size cap.
 * Returns: the parsed object and its raw text, or null if it isn't a JSON object within the cap.
 */
export async function readJson(request: Request, maxBytes = 16_384): Promise<{ data: Record<string, unknown>; text: string } | null> {
  const text = await request.text();
  if (text.length > maxBytes) return null;
  try {
    const data = JSON.parse(text);
    return data && typeof data === "object" && !Array.isArray(data) ? { data, text } : null;
  } catch {
    return null;
  }
}
