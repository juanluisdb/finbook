# Provider boundary fixtures

These files preserve sanitized response shapes at the provider gateway boundary. They contain no credentials, headers, account data, or personal identifiers.

- `coingecko-market-chart.json` mirrors the CoinGecko Demo API v3 range response used for transaction-rate lookup. Historical valuation tests use the range endpoint through the official SDK.

- `coingecko-bitcoin-eur-daily.json` retains only the public `prices` rows from a Bitcoin/EUR daily range obtained on 31 October 2026 through the installed SDK in explicit public-access mode. Its timestamps and prices are public source values for 21–23 October; each midnight row values the preceding closing date. No credentials, headers, or private book data are included.

The normal test gate never refreshes fixtures or contacts a provider. To refresh one, make the equivalent request manually with the pinned client, retain only fields needed to prove the real boundary shape, use public reference assets or clearly synthetic values, and review the diff for secrets before committing it. Keep the response envelope and field names unchanged.
