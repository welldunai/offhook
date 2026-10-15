import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dedicated dev port (kept clear of other local projects) so the backend's
// CORS allow-list matches. Override the API base with VITE_API_URL.
export default defineConfig({
  plugins: [react()],
  server: { port: 5273, strictPort: true },
  preview: { port: 4273, strictPort: true },
});
