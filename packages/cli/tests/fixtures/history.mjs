import { appendFileSync } from "node:fs";

globalThis.fetch = async (input) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== "eodhd.com") throw new Error("Unexpected network request");
  appendFileSync(process.env.FINBOOK_TEST_HTTP_LOG, `${url.pathname}\n`);
  if (url.pathname.endsWith("/OLD.EUFUND")) return new Response("unavailable", { status: 503 });
  if (process.env.FINBOOK_TEST_FAIL === "true") return new Response("unavailable", { status: 503 });
  return Response.json([
    { date: "2024-09-02", close: 40, adjusted_close: 39 },
    { date: "2024-09-03", close: 41, adjusted_close: 40 },
    { date: "2024-09-06", close: 42, adjusted_close: 41 },
  ]);
};
