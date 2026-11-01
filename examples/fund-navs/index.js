/** @type {import("@finbook/provider-sdk").ProviderFactory} */
const createProvider = () => ({
  ok: true,
  data: {
    async fetchPriceHistory(need) {
      if (need.identifier !== "EXAMPLE-FUND") {
        return { ok: false, error: { kind: "not-found", message: "Unknown example fund." } };
      }
      return {
        ok: true,
        data:
          need.through < "2024-09-02"
            ? []
            : [{ asOf: "2024-09-02", price: { amount: "105", currency: "EUR" } }],
      };
    },
  },
});
export default createProvider;
