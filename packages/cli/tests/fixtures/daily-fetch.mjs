import { appendFileSync } from "node:fs";

globalThis.fetch = async (input) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== "eodhd.com") throw new Error("Unexpected network request in CLI fixture.");
  appendFileSync(process.env.FINBOOK_TEST_HTTP_LOG, `${url.pathname}\n`);
  if (process.env.FINBOOK_TEST_FAIL === "true")
    return new Response("fixture unavailable", { status: 503 });
  return Response.json([{ date: url.searchParams.get("to"), close: 102 }]);
};
