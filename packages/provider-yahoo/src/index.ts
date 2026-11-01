export * from "./yahoo.js";
import type { ProviderFactory } from "@finbook/provider-sdk";
import { YahooSource } from "./yahoo.js";
const createProvider: ProviderFactory = () => {
  const source = new YahooSource();
  return { ok: true, data: { fetchPriceHistory: (need) => source.fetchPriceHistory(need) } };
};
export default createProvider;
