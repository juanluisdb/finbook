#!/usr/bin/env node

import { once } from "node:events";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FileBookStore, canonicalBookHome } from "@finbook/core";
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { z } from "zod";

import { createFinbookMcpHandler, MCP_MAX_REQUEST_BYTES } from "./server.js";

const HOST = "127.0.0.1";
const ENDPOINT = "/mcp";
const HomeSchema = z.string().trim().min(1);
const PortSchema = z
  .string()
  .regex(/^\d{1,5}$/u)
  .transform(Number)
  .pipe(z.number().max(65535))
  .default(3000);

async function main(): Promise<void> {
  const home = HomeSchema.safeParse(process.env.FINBOOK_HOME);
  if (!home.success) throw new Error("Set FINBOOK_HOME to an existing book outside the checkout.");
  const port = PortSchema.safeParse(process.env.FINBOOK_MCP_PORT);
  if (!port.success) throw new Error("FINBOOK_MCP_PORT must be an integer from 0 to 65535.");

  const checkout = fileURLToPath(new URL("../../../", import.meta.url));
  const dataHome = canonicalBookHome(resolve(home.data), checkout);
  const handler = createFinbookMcpHandler(new FileBookStore(dataHome));
  const serve = toNodeHandler(
    {
      async fetch(request, options) {
        const response = await handler.fetch(request, options);
        const streaming = response.headers.get("Content-Type")?.startsWith("text/event-stream");
        response.headers.set("Cache-Control", streaming ? "no-store, no-transform" : "no-store");
        return response;
      },
    },
    { maxRequestBodySize: MCP_MAX_REQUEST_BYTES },
  );
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const listener = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (!validateHost(request, response) || !validateOrigin(request, response)) return;
    const url = request.url;
    if (url === undefined || url.split("?", 1)[0] !== ENDPOINT) {
      response.writeHead(404).end();
      return;
    }
    if (request.method === undefined) {
      response.writeHead(400).end();
      return;
    }
    // The SDK's request shape requires method and URL to be absent or defined.
    void serve(
      {
        method: request.method,
        url,
        headers: request.headers,
        [Symbol.asyncIterator]: () => request[Symbol.asyncIterator](),
      },
      response,
    );
  });

  listener.listen(port.data, HOST);
  await once(listener, "listening");
  const { port: boundPort } = z.object({ port: z.number() }).parse(listener.address());
  const close = () => {
    listener.close();
    listener.closeAllConnections();
    void handler.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  process.stdout.write(`finbook MCP listening at http://${HOST}:${boundPort}${ENDPOINT}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `finbook MCP: ${error instanceof Error ? error.message : "Startup failed."}\n`,
  );
  process.exitCode = 1;
}
