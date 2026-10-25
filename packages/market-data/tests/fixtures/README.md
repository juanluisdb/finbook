# Provider boundary fixtures

These files preserve sanitized response shapes at the provider gateway boundary. They contain no credentials, headers, account data, or personal identifiers.

- `yahoo-chart.json` mirrors daily quote objects returned by `yahoo-finance2` after its HTTP parsing. Dates, prices, and volumes are synthetic. Tests supply the chart metadata, including currency and exchange timezone.
- `coingecko-market-chart.json` mirrors the CoinGecko Demo API v3 range response used for transaction-rate lookup. Daily valuation tests separately exercise the historical snapshot endpoint through the official SDK with a synthetic response envelope.

The normal test gate never refreshes fixtures or contacts a provider. To refresh one, make the equivalent request manually with the pinned client, retain only fields needed to prove the real boundary shape, replace all values with obviously synthetic equivalents, and review the diff for secrets before committing it. Keep the response envelope and field names unchanged.
