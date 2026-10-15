import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dedicated dev port (dashboard=5273, website=5274, docs=5275).
export default defineConfig({
  plugins: [react()],
  server: { port: 5275, strictPort: true },
});
