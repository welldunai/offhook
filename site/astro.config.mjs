import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

// Static output, deployed to Cloudflare like blog.welldun.ai.
export default defineConfig({
  site: "https://offhook.welldun.ai",
  integrations: [sitemap()],
});
