# Provider boundary fixtures

These files preserve sanitized response shapes at the provider gateway boundary. They contain no credentials, headers, account data, or personal identifiers.

- `yahoo-quote.json` and `yahoo-chart.json` mirror the objects returned by `yahoo-finance2` 4.0.2 after its HTTP parsing. Symbols, dates, prices, and volumes are synthetic.
- `coingecko-simple-price.json` and `coingecko-market-chart.json` mirror CoinGecko Demo API v3 responses consumed by the official TypeScript SDK. Coin IDs, dates, prices, market caps, and volumes are synthetic.

The normal test gate never refreshes fixtures or contacts a provider. To refresh one, make the equivalent request manually with the pinned client, retain only fields needed to prove the real boundary shape, replace all values with obviously synthetic equivalents, and review the diff for secrets before committing it. Keep the response envelope and field names unchanged.
