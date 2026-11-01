export * from "./coingecko.js";
import type { ProviderFactory } from "@finbook/provider-sdk";
import { CoinGeckoSource } from "./coingecko.js";
const createProvider: ProviderFactory = (environment) => {
  const source = new CoinGeckoSource({ demoApiKey: environment.FINBOOK_COINGECKO_DEMO_API_KEY });
  return {
    ok: true,
    data: {
      fetchPriceHistory: (need) => source.fetchPriceHistory(need),
      fetchFxHistory: (need) => source.fetchFxHistory(need),
      fetchHistoricalEurRates: (need) => source.fetchHistoricalEurRates(need),
    },
  };
};
export default createProvider;
