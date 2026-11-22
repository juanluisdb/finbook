import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { z } from "zod";

const checkout = resolve(import.meta.dirname, "../../..");
const cli = join(checkout, "packages/cli/dist/main.js");
const mcp = join(checkout, "packages/mcp/dist/main.js");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryHome(): string {
  const directory = mkdtempSync(join(tmpdir(), "finbook-mcp-"));
  temporaryDirectories.push(directory);
  return directory;
}

function runCli(home: string, ...args: string[]): string {
  const result = spawnSync(process.execPath, [cli, ...args, "--json"], {
    encoding: "utf8",
    env: { ...process.env, FINBOOK_HOME: home },
  });
  expect(result.status, result.stderr + result.stdout).toBe(0);
  return result.stdout;
}

async function startMcp(home: string): Promise<URL> {
  const child = spawn(process.execPath, [mcp], {
    env: { ...process.env, FINBOOK_HOME: home, FINBOOK_MCP_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stopped = once(child, "close");
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  onTestFinished(async () => {
    lines.close();
    child.kill();
    await stopped;
  });

  const [line] = await Promise.race([
    once(lines, "line", { signal: AbortSignal.timeout(4000) }),
    stopped.then(() => {
      throw new Error(`MCP exited during startup. ${stderr}`);
    }),
  ]);
  const address = /http:\/\/127\.0\.0\.1:\d+\/mcp/u.exec(z.string().parse(line))?.[0];
  if (!address) throw new Error("MCP did not announce a listening address.");
  return new URL(address);
}

async function connect(url: URL, era: "legacy" | "modern"): Promise<Client> {
  const client = new Client(
    { name: "finbook-test", version: "1" },
    {
      versionNegotiation: { mode: era === "modern" ? { pin: "2026-07-28" } : "legacy" },
    },
  );
  onTestFinished(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(url));
  expect(client.getProtocolEra()).toBe(era);
  return client;
}

function postStatus(url: URL, headers: Record<string, string> = {}): Promise<number | undefined> {
  return new Promise((resolveStatus, reject) => {
    const outgoing = request(url, { method: "POST", headers }, (response) => {
      response.resume();
      resolveStatus(response.statusCode);
    });
    outgoing.on("error", reject).end();
  });
}

it.each(["modern", "legacy"] as const)(
  "reads the live CLI book over %s Streamable HTTP",
  async (era) => {
    const home = temporaryHome();
    runCli(
      home,
      "account",
      "add",
      "--id",
      "demo",
      "--name",
      "Demo",
      "--platform",
      "example",
      "--country",
      "ES",
      "--custodial",
      "broker",
    );
    runCli(
      home,
      "instrument",
      "add",
      "--id",
      "DEMO",
      "--name",
      "Demo Shares",
      "--type",
      "stock",
      "--quote-currency",
      "EUR",
    );
    runCli(
      home,
      "event",
      "add",
      "deposit",
      "--date",
      "2026-07-01",
      "--account",
      "demo",
      "--amount",
      "100",
      "--currency",
      "EUR",
    );
    runCli(
      home,
      "event",
      "add",
      "buy",
      "--date",
      "2026-07-02",
      "--account",
      "demo",
      "--instrument",
      "DEMO",
      "--qty",
      "2",
      "--price-amount",
      "10",
      "--price-currency",
      "EUR",
      "--gross-amount",
      "20",
    );

    const url = await startMcp(home);
    const client = await connect(url, era);
    const listing = await client.listTools();
    expect(listing.tools).toMatchObject([
      {
        name: "get_portfolio_value",
        annotations: { readOnlyHint: true, openWorldHint: false },
        inputSchema: { required: ["asOf"] },
        outputSchema: { type: "object", required: ["asOf", "totalEur"] },
      },
    ]);

    const call = { name: "get_portfolio_value", arguments: { asOf: "2026-07-06" } };
    const unavailable = await client.callTool(call);
    expect(unavailable.isError).not.toBe(true);
    expect(unavailable).toMatchObject({
      structuredContent: { asOf: "2026-07-06", totalEur: null },
    });
    runCli(
      home,
      "price",
      "set",
      "--instrument",
      "DEMO",
      "--amount",
      "12.625",
      "--currency",
      "EUR",
      "--as-of",
      "2026-07-03",
    );
    expect(JSON.parse(runCli(home, "show", "glance", "--as-of", "2026-07-06"))).toMatchObject({
      data: { totalEur: { amount: "105.25", currency: "EUR" } },
    });
    const valued = await client.callTool(call);
    expect(valued).toMatchObject({
      structuredContent: { asOf: "2026-07-06", totalEur: "105.25" },
    });
    const text = valued.content.find((block) => block.type === "text");
    expect(JSON.parse(text?.text ?? "null")).toEqual(valued.structuredContent);
    runCli(
      home,
      "price",
      "set",
      "--instrument",
      "DEMO",
      "--amount",
      "14.125",
      "--currency",
      "EUR",
      "--as-of",
      "2026-07-03",
    );
    expect(await client.callTool(call)).toMatchObject({
      structuredContent: { asOf: "2026-07-06", totalEur: "108.25" },
    });
  },
);

it("discovers the tool without a book and fails calls without creating one", async () => {
  const missingHome = join(temporaryHome(), "missing");
  const client = await connect(await startMcp(missingHome), "modern");

  expect((await client.listTools()).tools).toMatchObject([{ name: "get_portfolio_value" }]);
  expect(existsSync(missingHome)).toBe(false);

  const invalid = await client.callTool({
    name: "get_portfolio_value",
    arguments: { asOf: "2026-02-30" },
  });
  expect(invalid).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining("calendar date") }],
  });
  const missing = await client.callTool({
    name: "get_portfolio_value",
    arguments: { asOf: "2026-07-06" },
  });
  expect(missing).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining("existing book") }],
  });
  expect(JSON.stringify(missing)).not.toContain(missingHome);
  expect(existsSync(missingHome)).toBe(false);
});

it("returns a recoverable tool error for a locked book without exposing lock details", async () => {
  const home = temporaryHome();
  runCli(home, "show", "glance", "--as-of", "2026-07-06");
  mkdirSync(join(home, ".finbook.lock"));
  const client = await connect(await startMcp(home), "modern");

  const result = await client.callTool({
    name: "get_portfolio_value",
    arguments: { asOf: "2026-07-06" },
  });
  expect(result).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining("finbook doctor") }],
  });
  expect(JSON.stringify(result)).not.toContain(home);
  expect(JSON.stringify(result)).not.toContain(".finbook.lock");
  expect(existsSync(join(home, ".finbook.lock"))).toBe(true);
});

it("only accepts its route and loopback Host and Origin headers", async () => {
  const url = await startMcp(temporaryHome());

  expect(await postStatus(new URL("/other", url))).toBe(404);
  expect(await postStatus(url, { Host: "external.example" })).toBe(403);
  expect(await postStatus(url, { Origin: "https://external.example" })).toBe(403);

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  expect(response.headers.get("cache-control")).toBe("no-store");
  await response.body?.cancel();
});

it("requires an explicit external book path on startup", () => {
  const alias = join(temporaryHome(), "checkout-alias");
  symlinkSync(checkout, alias, "dir");

  const absent = spawnSync(process.execPath, [mcp], {
    encoding: "utf8",
    timeout: 4000,
    env: { ...process.env, FINBOOK_HOME: undefined },
  });
  expect(absent.status).toBe(1);
  expect(absent.stderr).toContain("Set FINBOOK_HOME");

  const inside = spawnSync(process.execPath, [mcp], {
    encoding: "utf8",
    timeout: 4000,
    env: { ...process.env, FINBOOK_HOME: join(alias, "book"), FINBOOK_MCP_PORT: "0" },
  });
  expect(inside.status).toBe(1);
  expect(inside.stderr).toContain("outside the checkout");
});
