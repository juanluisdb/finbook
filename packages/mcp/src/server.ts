import type { FileBookStore } from "@finbook/core";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";

import { registerPortfolioValue } from "./tools/portfolio-value.js";

export function createFinbookMcpHandler(store: FileBookStore) {
  return createMcpHandler(() => {
    const server = new McpServer({ name: "finbook", version: "0.1.0" });
    registerPortfolioValue(server, store);
    return server;
  });
}
