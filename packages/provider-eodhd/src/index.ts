export * from "./eodhd.js";
import type { ProviderFactory } from "@finbook/provider-sdk";
import { EodhdSource } from "./eodhd.js";
const createProvider: ProviderFactory = (environment) => {
  if (!environment.FINBOOK_EODHD_API_KEY?.trim())
    return {
      ok: false,
      error: { kind: "unauthorized", message: "EODHD requires FINBOOK_EODHD_API_KEY." },
    };
  const source = new EodhdSource({ apiKey: environment.FINBOOK_EODHD_API_KEY });
  return { ok: true, data: { fetchPriceHistory: (need) => source.fetchPriceHistory(need) } };
};
export default createProvider;
