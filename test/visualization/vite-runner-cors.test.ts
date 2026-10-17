import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import viteConfig from "../../vite.config.ts";

test("development CORS is limited to the opaque-origin visualization runner script", async () => {
  const server = await createServer({
    ...viteConfig,
    configFile: false,
    server: {
      ...viteConfig.server,
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
    },
  });

  try {
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;

    const runnerResponse = await fetch(`${origin}/visualization-runner.js`, { headers: { Origin: "null" } });
    assert.equal(runnerResponse.status, 200);
    assert.equal(runnerResponse.headers.get("access-control-allow-origin"), "null");
    assert.equal(runnerResponse.headers.get("cross-origin-resource-policy"), "cross-origin");
    assert.match(runnerResponse.headers.get("vary") ?? "", /Origin/i);

    const appResponse = await fetch(`${origin}/`, { headers: { Origin: "null" } });
    assert.equal(appResponse.status, 200);
    assert.equal(appResponse.headers.get("access-control-allow-origin"), null);
  } finally {
    await server.close();
  }
});
