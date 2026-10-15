import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dedicated dev port so it doesn't collide with the dashboard (5273).
export default defineConfig({
  plugins: [react()],
  server: { port: 5274, strictPort: true },
});
