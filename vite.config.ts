import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false, // keep Rust compile errors visible
  server: {
    port: 1420, // must match devUrl in src-pulo/tauri.conf.json
    strictPort: true,
    watch: { ignored: ["**/src-pulo/**"] },
  },
});
