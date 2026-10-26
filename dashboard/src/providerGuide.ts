// What each provider's connection needs, where to find it, and how to check it.
// Field keys are the secrets the API stores (app/telephony/*, app/providers/*).

export interface GuideField {
  key: string;
  label: string;
  hint: string;
  secret?: boolean;
  placeholder?: string;
  /** Checked before saving; `message` says what's wrong. */
  check?: { pattern: RegExp; message: string };
}

export interface ProviderGuide {
  name: string;
  /** Where to get the values. */
  console: { label: string; url: string };
  steps: string[];
  fields: GuideField[];
}

const E164 = { pattern: /^\+[1-9]\d{6,14}$/, message: "Use the full international format, like +14155550123." };

export const GUIDES: Record<string, ProviderGuide> = {
  twilio: {
    name: "Twilio",
    console: { label: "Open the Twilio console", url: "https://console.twilio.com/" },
    steps: [
      "Sign in to Twilio. On the console home page, find Account Info: it shows your Account SID and Auth Token.",
      "Buy or pick a number under Phone Numbers → Manage → Active numbers. That's the number your agent calls from.",
      "On a trial account, Twilio only calls numbers you've verified (Phone Numbers → Verified Caller IDs).",
    ],
    fields: [
      { key: "account_sid", label: "Account SID", hint: "Starts with AC.", placeholder: "AC…", check: { pattern: /^AC[0-9a-fA-F]{32}$/, message: "An Account SID is AC followed by 32 letters and numbers." } },
      { key: "auth_token", label: "Auth Token", hint: "Next to the Account SID. Click to reveal it.", secret: true },
      { key: "from_number", label: "Your Twilio number", hint: "The number calls come from.", placeholder: "+14155550123", check: E164 },
    ],
  },
  plivo: {
    name: "Plivo",
    console: { label: "Open the Plivo console", url: "https://console.plivo.com/dashboard/" },
    steps: [
      "Sign in to Plivo. The dashboard's Account section shows your Auth ID and Auth Token.",
      "Buy or pick a number under Phone Numbers → Your Numbers. That's the number your agent calls from.",
    ],
    fields: [
      { key: "auth_id", label: "Auth ID", hint: "Starts with MA or SA.", placeholder: "MA…", check: { pattern: /^[MS]A[A-Z0-9]{18}$/, message: "A Plivo Auth ID is MA or SA followed by 18 letters and numbers." } },
      { key: "auth_token", label: "Auth Token", hint: "Next to the Auth ID.", secret: true },
      { key: "from_number", label: "Your Plivo number", hint: "The number calls come from.", placeholder: "+14155550123", check: E164 },
    ],
  },
  deepgram: {
    name: "Deepgram",
    console: { label: "Open Deepgram", url: "https://console.deepgram.com/" },
    steps: ["In the Deepgram console, open API Keys and create a key with Member access."],
    fields: [{ key: "api_key", label: "API key", hint: "Shown once when you create it.", secret: true }],
  },
  cartesia: {
    name: "Cartesia",
    console: { label: "Open Cartesia", url: "https://play.cartesia.ai/" },
    steps: [
      "In Cartesia, open API Keys and create a key.",
      "Pick a voice in the voice library and copy its ID from the voice's details.",
    ],
    fields: [
      { key: "api_key", label: "API key", hint: "Shown once when you create it.", secret: true },
      { key: "voice_id", label: "Voice ID", hint: "The voice your agents speak with. An agent can still choose another.", placeholder: "a0e99841-438c-4a64-b679-ae501e7d6091",
        check: { pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, message: "A Cartesia voice ID looks like a0e99841-438c-4a64-b679-ae501e7d6091." } },
    ],
  },
  groq: {
    name: "Groq",
    console: { label: "Open Groq", url: "https://console.groq.com/keys" },
    steps: ["In the Groq console, open API Keys and create a key."],
    fields: [{ key: "api_key", label: "API key", hint: "Starts with gsk_.", secret: true, check: { pattern: /^gsk_/, message: "Groq keys start with gsk_." } }],
  },
  openai: {
    name: "OpenAI",
    console: { label: "Open OpenAI", url: "https://platform.openai.com/api-keys" },
    steps: ["In the OpenAI platform, open API keys and create a secret key."],
    fields: [{ key: "api_key", label: "API key", hint: "Starts with sk-.", secret: true }],
  },
  gemini: {
    name: "Gemini",
    console: { label: "Open Google AI Studio", url: "https://aistudio.google.com/apikey" },
    steps: ["In Google AI Studio, create an API key."],
    fields: [{ key: "api_key", label: "API key", hint: "From Google AI Studio.", secret: true }],
  },
  openrouter: {
    name: "OpenRouter",
    console: { label: "Open OpenRouter", url: "https://openrouter.ai/keys" },
    steps: ["In OpenRouter, open Keys and create a key."],
    fields: [{ key: "api_key", label: "API key", hint: "Starts with sk-or-.", secret: true }],
  },
};

/** The guide for a provider, or a plain one-key guide for providers without one. */
export function guideFor(provider: string): ProviderGuide {
  return GUIDES[provider] ?? {
    name: provider,
    console: { label: `Open ${provider}`, url: "#" },
    steps: [],
    fields: [{ key: "api_key", label: "API key", hint: "", secret: true }],
  };
}

/**
 * Checks the values for a provider before saving.
 * Args: provider — the provider name; values — what the user typed.
 * Returns: a message for the first problem, or null when everything looks right.
 */
export function checkValues(provider: string, values: Record<string, string>): string | null {
  for (const f of guideFor(provider).fields) {
    const v = (values[f.key] ?? "").trim();
    if (!v) return `Add the ${f.label.toLowerCase()}.`;
    if (f.check && !f.check.pattern.test(v)) return `${f.label}: ${f.check.message}`;
  }
  return null;
}
