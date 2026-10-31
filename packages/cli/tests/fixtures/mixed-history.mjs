import { appendFileSync, readFileSync } from "node:fs";

const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length === 0 ? ["2026-10-31T12:00:00Z"] : args));
  }
  static now() {
    return RealDate.parse("2026-10-31T12:00:00Z");
  }
};

globalThis.fetch = async (input) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  appendFileSync(process.env.FINBOOK_TEST_HTTP_LOG, `${url.hostname}${url.pathname}\n`);
  if (process.env.FINBOOK_TEST_OFFLINE === "true") throw new Error("Network is unavailable");
  if (url.hostname === "eodhd.com") {
    const rows = url.pathname.endsWith("/AAPL.US")
      ? [
          { date: "2026-10-20", close: 105 },
          { date: "2026-10-22", close: 107 },
        ]
      : [
          { date: "2026-10-19", close: 20 },
          { date: "2026-10-21", close: 22 },
        ];
    return Response.json(
      rows.filter(
        (row) =>
          row.date <= url.searchParams.get("to") &&
          (url.searchParams.get("from") === null || row.date >= url.searchParams.get("from")),
      ),
    );
  }
  if (url.hostname === "www.ecb.europa.eu")
    return new Response(
      '<gesmes:Envelope><Cube><Cube time="2026-10-19"><Cube currency="USD" rate="1.25"/></Cube></Cube></gesmes:Envelope>',
    );
  if (url.hostname === "api.coingecko.com" && url.pathname.endsWith("/market_chart/range")) {
    if (process.env.FINBOOK_TEST_FAIL_CRYPTO === "true")
      return new Response("unavailable", { status: 503, headers: { "retry-after": "60" } });
    return new Response(
      readFileSync(
        new URL(
          "../../../market-data/tests/fixtures/coingecko-bitcoin-eur-daily.json",
          import.meta.url,
        ),
        "utf8",
      ),
      { headers: { "content-type": "application/json" } },
    );
  }
  throw new Error("Unexpected network request");
};
