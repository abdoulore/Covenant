import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The app talks only to the Covenant API. In dev, Vite proxies /api to the local API so the browser
// sees one origin and the session cookie travels same-origin (no CORS needed locally). In production
// the app is a static bundle and the API lives on its own origin, where the API's pinned CORS and
// credentialed cookies take over. Override the dev target with COVENANT_API_TARGET if the API runs
// on a non-default port.
const apiTarget = process.env.COVENANT_API_TARGET ?? "http://localhost:4320";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
