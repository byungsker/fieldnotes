import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiOrigin = process.env.KB_API_ORIGIN ?? "http://127.0.0.1:4178";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.VITE_PORT ?? 4177),
    strictPort: true,
    proxy: {
      "/api": { target: apiOrigin },
    },
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
});
