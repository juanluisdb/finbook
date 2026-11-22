import { getGlance, IsoDateSchema, type FileBookStore } from "@finbook/core";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const PortfolioValueSchema = z.object({ asOf: IsoDateSchema, totalEur: z.string().nullable() });

export function registerPortfolioValue(server: McpServer, store: FileBookStore): void {
  server.registerTool(
    "get_portfolio_value",
    {
      description:
        "Calculate the EUR portfolio value on a given date using the latest saved price and exchange-rate observations on or before that date. The value is null when a required observation is missing.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.strictObject({
        asOf: IsoDateSchema.describe("Valuation date in YYYY-MM-DD format."),
      }),
      outputSchema: PortfolioValueSchema,
    },
    ({ asOf }) => {
      try {
        const book = store.loadExisting();
        if (!book.ok) {
          if (book.error.type === "not-found") {
            return toolError(
              "The configured book is missing. Start MCP with FINBOOK_HOME pointing to an existing book.",
            );
          }
          return toolError(
            "The configured book could not be read. If finbook is using it, retry when it finishes. If the problem persists, run finbook doctor against that book.",
          );
        }

        const glance = getGlance(book.data, asOf);
        if (!glance.ok) {
          return toolError(
            "The portfolio value could not be calculated. Run finbook doctor against the configured book.",
          );
        }

        const value = { asOf: glance.data.asOf, totalEur: glance.data.totalEur?.amount ?? null };
        return {
          structuredContent: value,
          content: [{ type: "text", text: JSON.stringify(value) }],
        };
      } catch {
        process.stderr.write("finbook MCP: unexpected error while reading the portfolio value.\n");
        return toolError(
          "An internal error prevented the portfolio read. Check the local MCP server logs.",
        );
      }
    },
  );
}

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}
