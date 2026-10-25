/// <reference path="../.astro/types.d.ts" />
interface ImportMetaEnv {
  /** The demo Worker, e.g. https://demo.offhook.welldun.ai. Unset: the live demo is off. */
  readonly PUBLIC_DEMO_API?: string;
  /** Cloudflare Turnstile site key for the demo. */
  readonly PUBLIC_TURNSTILE_SITE_KEY?: string;
}
