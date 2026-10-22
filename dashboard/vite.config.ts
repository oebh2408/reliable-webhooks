import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The build is served by createDashboard() from dashboard/dist. In development,
// run `npm run dashboard` (API on :4000) and `npm run dev:dashboard` side by side.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 800 },
  server: { proxy: { "/api": "http://127.0.0.1:4000" } },
});
