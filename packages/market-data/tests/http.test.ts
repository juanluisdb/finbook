import { createServer, type AddressInfo, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createRetryingFetch } from "../src/index.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        }),
    ),
  );
});

function startServer(
  handler: (requestCount: number) => { status: number; body: string; retryAfter?: string },
) {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    const result = handler(requestCount);
    if (result.retryAfter !== undefined) response.setHeader("retry-after", result.retryAfter);
    response.writeHead(result.status, { "content-type": "text/plain" });
    response.end(result.body);
  });
  servers.push(server);
  const url = new Promise<URL>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null) throw new Error("Server did not bind");
      // SAFETY: server.listen binds a TCP socket, so address is AddressInfo here.
      const { port } = address as AddressInfo;
      resolve(new URL(`http://127.0.0.1:${port}/quote`));
    });
  });
  return { url, requests: () => requestCount };
}

describe("market-data HTTP transport", () => {
  it("honors a retryable 429 and returns the successful response", async () => {
    const server = startServer((requestCount) =>
      requestCount === 1
        ? { status: 429, body: "slow down", retryAfter: "0" }
        : { status: 200, body: "ok" },
    );

    const response = await createRetryingFetch()(await server.url);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(server.requests()).toBe(2);
  });

  it("does not retry a non-transient client error", async () => {
    const server = startServer(() => ({ status: 404, body: "missing" }));

    const response = await createRetryingFetch()(await server.url);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("missing");
    expect(server.requests()).toBe(1);
  });

  it("does not wait for a rate-limit retry beyond the request budget", async () => {
    const server = startServer(() => ({ status: 429, body: "later", retryAfter: "86400" }));

    const response = await createRetryingFetch()(await server.url);

    expect(response.status).toBe(429);
    expect(await response.text()).toBe("later");
    expect(server.requests()).toBe(1);
  });
});
