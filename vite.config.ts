import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const apiOrigin = process.env.KB_API_ORIGIN ?? "http://127.0.0.1:4178";

function runnerScriptCors(): Plugin {
  return {
    name: "fieldnotes-runner-script-cors",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const requestPath = request.url?.split("?", 1)[0];
        if (request.method === "GET" && requestPath === "/visualization-runner.js") {
          response.setHeader("Vary", "Origin");
          if (request.headers.origin === "null") {
            response.setHeader("Access-Control-Allow-Origin", "null");
            response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
          }
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), runnerScriptCors()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.VITE_PORT ?? 4177),
    strictPort: true,
    cors: false,
    proxy: {
      "/api": { target: apiOrigin },
    },
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
});
