import type { FileBookStore } from "@finbook/core";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";

import { registerPortfolioValue } from "./tools/portfolio-value.js";

export const MCP_MAX_REQUEST_BYTES = 64 * 1024;

export function createFinbookMcpHandler(store: FileBookStore) {
  return createMcpHandler(
    () => {
      const server = new McpServer(
        { name: "finbook", version: "0.1.0" },
        { maxToolInputElements: 32 },
      );
      registerPortfolioValue(server, store);
      return server;
    },
    { maxRequestBodySize: MCP_MAX_REQUEST_BYTES },
  );
}
