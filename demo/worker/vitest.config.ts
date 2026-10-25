import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests run in Node. The Durable Object base class only exists in workerd, so it is
// stubbed; the Gate's logic (Quotas) is tested directly against node:sqlite.
export default defineConfig({
  resolve: { alias: { "cloudflare:workers": fileURLToPath(new URL("./test/stubs/cloudflare-workers.ts", import.meta.url)) } },
});
