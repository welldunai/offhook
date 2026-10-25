import { callLimits, gateOf, type Env } from "../config";
import { json } from "../http";
import { utcDay } from "../visitor";
import { voiceOnline } from "../voice";

/**
 * GET /status: can a visitor start a call right now?
 * Args: env — vars and bindings.
 * Returns: 200 {online, busy, paused}; the site shows the matching message.
 */
export async function status(env: Env): Promise<Response> {
  const online = await voiceOnline(env.VOICE_URL);
  const now = Date.now();
  const { busy, paused } = await gateOf(env).lineStatus(utcDay(new Date(now)), now, callLimits(env));
  return json({ online, busy, paused });
}
