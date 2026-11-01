export * from "./ecb.js";
import type { ProviderFactory } from "@finbook/provider-sdk";
import { EcbSource } from "./ecb.js";
const createProvider: ProviderFactory = () => {
  const source = new EcbSource();
  return {
    ok: true,
    data: {
      fetchFxHistory: (need) => source.fetchFxHistory(need),
      fetchHistoricalEurRates: (need) => source.fetchHistoricalEurRates(need),
    },
  };
};
export default createProvider;
