# Market-data subsystem

`packages/market-data` turns explicit price and EUR-rate needs into validated local stamps. It isolates network providers from the event book and preserves useful partial progress when one request fails.

The subsystem never discovers portfolio holdings, changes events, schedules work, or fetches in the background. The CLI derives needs from a requested view or event and invokes the coordinator deliberately.

## Follow the resolution flow

```text
view holes or event rate
          |
          v
 normalized need
          |
          v
 route -> binding -> enabled provider
          |
          v
 provider adapter -> validated observation
          |
          v
 append one local stamp
          |
          v
 report fetched, cached, and failed needs
```

`packages/market-data/src/contracts.ts` defines the normalized needs, observations, provider failures, source interfaces, route keys, and capability registry.

`packages/market-data/src/coordinator.ts::MarketDataCoordinator` selects providers, batches compatible needs, validates observations against the request, appends successes, and returns a complete report.

Provider adapters translate their external API into those contracts. Core sees only normalized price stamps, FX stamps, and historical event-rate facts.

## Distinguish valuation from event history

Price observations value an instrument on an economic date. FX observations value one unit of a currency in EUR on an economic date. Both become stamps in the local book.

Historical EUR-rate observations prepare rate-bearing events. The CLI embeds the normalized rate, effective date, provider, and retrieval instant into the event before append.

A current FX stamp must not supply an event’s historical `eurPerUnit`. Fetching a historical event rate must not append a valuation stamp as a side effect.

Fetched provenance records the provider and a UTC retrieval instant. Economic dates remain date-only values.

## Route without guessing

Provider capabilities have one source of truth in `packages/market-data/src/contracts.ts::PROVIDER_CAPABILITIES`.

Default route order lives in `packages/market-data/src/config.ts::defaultRoute`. Route overrides may reorder or replace that list, and disabled providers are removed from effective routes.

An explicit provider option pins the request to that provider. A source binding pins one local instrument or currency to a provider-specific identifier. Pinned selection does not silently fall back to another provider.

Instrument bindings require an existing local instrument because the book owns that namespace. Currency bindings validate the currency shape but do not require a registry because the book has none.

Configuration validation rejects duplicate bindings and providers assigned to unsupported routes. Selection also rejects disabled providers and empty effective routes before calling an adapter.

The resolution precedence lives in `packages/market-data/src/coordinator.ts::selectPriceProviders`, `packages/market-data/src/coordinator.ts::selectFxProviders`, and `packages/market-data/src/coordinator.ts::selectHistoricalEurRateProviders`.

## Keep configuration non-secret

`packages/market-data/src/config.ts::MarketDataConfigStore` stores disabled providers, route overrides, and source bindings in `$FINBOOK_HOME/market-data.json`.

The store validates on read and writes replacements atomically under the same book lock as core storage. Inspection returns defaults without creating a missing file.

Credentials come from the process environment when `packages/cli/src/main.ts::main` constructs providers. They do not enter market-data configuration, book records, command output, or logs.

CoinGecko reads its demo API credential from `FINBOOK_COINGECKO_DEMO_API_KEY`. Yahoo and ECB need no configured credential.

## Fetch current and historical data deliberately

A need declares an economic date and whether its intent is latest or historical.

Historical resolution may reuse a valid cached stamp on or before the requested date. Latest resolution always calls a provider, even when a prior mark exists, because a cached observation does not satisfy the intent to refresh.

The CLI uses latest mode only when the requested date is its resolved current date. An explicit earlier date uses historical mode.

Provider observations may use an effective date on or before the requested historical date, but never a future date. Adapters own provider-specific windows and selection rules.

Latest observations use the requested book date as their economic date after the provider timestamp proves the value is current. This avoids turning exchange and book timezone boundaries into different portfolio dates. Yahoo accepts quotes observed within seven days, while CoinGecko accepts prices observed within 24 hours; both reject missing, stale, invalid, or implausibly future timestamps without appending a stamp.

Yahoo is the default price source for stocks, ETFs, funds, and ETCs, and validates the returned quote currency against the instrument. CoinGecko provides crypto prices, bound crypto-to-EUR values, and historical crypto EUR rates. ECB provides fiat-to-EUR valuation and historical rates.

Adapter behaviour lives in `packages/market-data/src/yahoo.ts::YahooSource`, `packages/market-data/src/coingecko.ts::CoinGeckoSource`, and `packages/market-data/src/ecb.ts::EcbSource`.

## Preserve partial progress

`packages/market-data/src/coordinator.ts::MarketDataCoordinator.resolvePrices` and `packages/market-data/src/coordinator.ts::MarketDataCoordinator.resolveFxRates` deduplicate requested needs and skip eligible historical cache hits.

Compatible pending needs are grouped by provider. Each valid observation is appended immediately through the store before the coordinator advances to the next work.

Default route lists can fall through to their next provider after a failed outcome. Exhausted and unrouteable needs remain explicit failures with the provider and normalized failure kind.

A storage failure stops resolution because the subsystem cannot claim the observation was saved. A provider failure does not discard observations already appended.

The CLI reloads the book after fetching and derives the partial or complete view from persisted state. An incomplete fetch exits as an external failure while still returning the useful view and counts of requested and saved work.

## Normalize failures

Provider failures use the stable categories defined by `packages/market-data/src/contracts.ts::ProviderFailureKind`: unsupported, not found, rate limited, unauthorized, unavailable, or invalid response.

Adapters validate response structure and semantic fields before constructing an observation. A provider returning the wrong subject, currency, pair, date direction, or provenance is an invalid response.

`packages/market-data/src/http.ts::createRetryingFetch` centralizes bounded retries for transient transport and HTTP failures and respects acceptable `Retry-After` values. Exact retry and timeout values remain in that source.

Provider SDKs and response shapes stay inside their adapters. No raw provider response is written to the book.

## Test without live providers

Adapter tests use captured fixtures, injected gateways, and local fetch behaviour. The normal repository gate makes no live network request.

Coordinator tests use controlled sources to cover routing, batching, fallback, cache intent, response validation, incremental persistence, and partial failure.

Configuration tests exercise schema validation and the real temporary filesystem. CLI tests cover the user-visible fetch and historical-rate contracts against injected market-data construction.
