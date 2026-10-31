# Market-data subsystem

`packages/market-data` resolves historical and single-date portfolio valuation needs into validated local stamps. It isolates network providers from the event book, reuses completed work, and preserves partial progress when one request fails.

`packages/market-data/src/coordinator.ts::MarketDataCoordinator.updateHistory` delegates whole-book historical acquisition to `packages/market-data/src/history.ts::HistoryUpdater`. `packages/market-data/src/coordinator.ts::MarketDataCoordinator.refreshValuation` derives needs for the holdings and cash in a requested core view, resolves daily observations, and handles manual-mark conflicts. The subsystem never changes transactions, schedules work, or fetches without an invoking caller. Historical event-rate resolution is a separate operation.

## Follow the resolution flow

```text
requested portfolio date
          |
          v
 holdings -> daily targets -> resolution receipts
          |
          v
 route -> binding -> enabled provider
          |
          v
 provider adapter -> validated observation
          |
          v
 append one local stamp -> save its resolution receipt
          |
          v
 report fetched, cached, and failed needs
```

`packages/market-data/src/contracts.ts` defines the normalized needs, observations, provider failures, source interfaces, route keys, and capability registry.

`packages/market-data/src/coordinator.ts::MarketDataCoordinator` selects providers, batches compatible needs, validates observations against the request, appends successes, and returns a complete report.

Provider adapters translate their external API into those contracts. Core sees only normalized price stamps, FX stamps, and historical event-rate facts.

## Distinguish valuation from event history

Price observations value an instrument on an economic date. FX observations value one unit of a currency in EUR on an economic date. Both become stamps in the local book.

Historical EUR-rate observations prepare contribution events and explicitly requested reporting evidence. The CLI embeds the normalized rate, effective date, provider, and retrieval instant into the event before append.

A current FX stamp must not supply an event’s historical `eurPerUnit`. Fetching a historical event rate must not append a valuation stamp as a side effect.

Fetched provenance records the provider and a UTC retrieval instant. Economic dates remain date-only values and retain the provider's observation date. Refresh-cycle dates and retrieval times do not replace them.

## Route without guessing

Provider capabilities have one source of truth in `packages/market-data/src/contracts.ts::PROVIDER_CAPABILITIES`.

Default route order lives in `packages/market-data/src/config.ts::defaultRoute`. Route overrides may reorder or replace that list, and disabled providers are removed from effective routes.

An explicit provider option pins the request to that provider. A source binding pins one local instrument or currency to a provider-specific identifier. Pinned selection does not silently fall back to another provider.

Instrument bindings require an existing local instrument because the book owns that namespace. Currency bindings validate the currency shape but do not require a registry because the book has none.

Configuration validation rejects duplicate bindings and providers assigned to unsupported routes. Selection also rejects disabled providers and empty effective routes before calling an adapter.

The resolution precedence lives in `packages/market-data/src/routing.ts::selectPriceProviders`, `packages/market-data/src/routing.ts::selectFxProviders`, and `packages/market-data/src/routing.ts::selectHistoricalEurRateProviders`.

## Keep configuration non-secret

`packages/market-data/src/config.ts::MarketDataConfigStore` stores disabled providers, route overrides, and source bindings in `$FINBOOK_HOME/market-data.json`.

The store validates on read and writes replacements atomically under the same book lock as core storage. Inspection returns defaults without creating a missing file.

Credentials come from the process environment when `packages/cli/src/main.ts::main` constructs providers. They do not enter market-data configuration, book records, command output, or logs.

CoinGecko reads its demo API credential from `FINBOOK_COINGECKO_DEMO_API_KEY`. EODHD reads `FINBOOK_EODHD_API_KEY`. Yahoo and ECB need no configured credential.

## Acquire history from recorded exposures

```text
recorded events -> end-of-day core queries -> required exposure intervals
    -> subtract intact source-matching checks -> newest unchecked ranges
    -> native provider range / batched ECB feed -> validate whole response
    -> retain interval and latest predecessor -> append each observation
    -> persist range check -> report saved, reused, empty and failed work
```

`packages/market-data/src/history-plan.ts::historyRequirements` queries core at event-date boundaries. Holdings require prices; both foreign cash and a held instrument's quote currency require FX. Subjects are deduplicated across accounts and adjacent exposures merge. Fully sold positions and spent currencies remain historical requirements. This planning introduces no parallel accounting state.

`packages/market-data/src/history.ts::HistoryUpdater` subtracts the union of matching checked intervals and sorts unchecked work by its newest required end date. The completed-date cutoff comes from `packages/market-data/src/daily.ts::dailyTarget`. It uses native range operations rather than repeating single-date calls. Compatible currency needs share a provider batch.

The range contracts live in `packages/market-data/src/contracts.ts::PriceHistorySource` and `packages/market-data/src/contracts.ts::FxHistorySource`. A logical portfolio interval is explicit. When no locally stored predecessor exists, the normalized request leaves its source start open and the adapter requests available historical context. Otherwise incremental requests start at the unchecked range. Only observations within the logical interval and its latest eligible predecessor are retained.

Yahoo history supports fund NAVs and preserves exchange-local dates. Its historical stock closes can use split-adjusted units, so that operation rejects stocks. EODHD history supports funds and stocks and uses raw closes. Default routes remain shared with single-date fetching; a historical stock therefore needs an EODHD binding or route. ECB reads its historical feed once per batch, preserves economic dates, and inverts foreign units per EUR into EUR per foreign unit. No bundled crypto history operation exists.

`packages/market-data/src/history-checks.ts::HistoryChecks` owns append-only `market-history.jsonl` under the book lock. A check records the subject and effective route/binding identity, logical interval, check instant, serving provider, and the actual retained normalized observations. Credentials never enter this identity. `packages/market-data/src/history-checks.ts::checkIsIntact` requires those facts still to exist before a receipt can suppress work. Valid empty checks retain an empty evidence list; errors receive no successful check.

A check is written only after every retained observation is saved. Interrupted commits preserve earlier stamps and leave the range retryable. An unchanged fetched fact can be reused with its original retrieval identity, while a changed latest candidate is appended. Provider failures preserve completed ranges. Storage failures stop the operation. The refresh lock spans the whole update; ordinary book locks cover only local reads and commits.

Historical checks have no expiry, automatic overlap, or corrective recheck command. Late NAVs and corrections within checked periods can stay absent. A new unchecked request may incidentally return older data, and retaining its predecessor can improve an earlier value. Changing a binding or effective route creates distinct work; adding earlier events exposes unchecked earlier intervals.

`packages/market-data/src/history.ts::HistoryUpdateReport` carries checked, reused, empty and failed ranges, saved-observation counts, and manual conflicts. Reads derive values from the saved facts and show missing inputs and selected dates; a successful provider check is not a guarantee of complete portfolio value. Historical update preserves manual marks and reports candidates without accepting replacements.

## Keep acquisition records separate

The explicit whole-book update and the single-date `--fetch` operation have separate request semantics and receipt formats. `market-history.jsonl` records durable intervals; `market-refresh.jsonl` records daily point resolutions. Both append the same core price and FX facts. Neither receipt format is valuation data, and neither proves the other's request completed. Historical event-rate lookup remains independent of both.

## Resolve daily observations

`packages/market-data/src/daily.ts::dailyCycle` defines the UTC cycle boundary. `packages/market-data/src/daily.ts::dailyTarget` caps price and fiat FX requests at the preceding completed UTC date and crypto requests at the cycle's midnight UTC snapshot. The requested portfolio date is an additional upper bound. Invoking the operation late does not advance these targets into an intraday session.

A need declares a target economic date. The provider may return an older eligible observation, such as a prior trading close or delayed NAV, but never an observation after the target. A successful lagging response completes the check for that cycle and becomes eligible for another check in the next one.

Yahoo is the default price source for stocks, ETFs, funds, and ETCs. It reads daily chart closes, validates the returned quote currency, and interprets the trading date in the exchange timezone. It does not fetch live quotes for portfolio valuation.

EODHD provides fund and stock prices from its daily EOD feed and is opt-in through a source binding. It uses the raw close because adjusted closes belong to return analysis rather than unit valuation. One unresolved single-date need costs one request; there is no discovery, bulk feed, or automatic retry.

CoinGecko uses its dated historical snapshot endpoint for crypto valuation and bound crypto cash. The observation represents midnight UTC on the requested date. Historical event rates retain their separate range-based lookup and are not subject to the valuation refresh cycle.

ECB selects the latest eligible daily reference rate from its historical feed and batches currency needs. Transaction-rate lookup remains separate from valuation stamps.

Adapter behaviour lives in `packages/market-data/src/yahoo.ts::YahooSource`, `packages/market-data/src/coingecko.ts::CoinGeckoSource`, `packages/market-data/src/ecb.ts::EcbSource`, and `packages/market-data/src/eodhd.ts::EodhdSource`.

## Reuse resolutions, not arbitrary old marks

`packages/market-data/src/daily.ts::DailyResolutions` owns append-only `market-refresh.jsonl` records under the book lock. Each receipt identifies the subject, target, effective route and binding, cycle, retrieval instant, and saved observation. Identifiers are non-secret; credentials never enter a receipt.

`packages/market-data/src/daily.ts::cachedResolution` requires both a matching request identity and the referenced observation in the book. Successful same-cycle receipts are reusable even when the provider returned an older date. Exact-target receipts remain reusable across cycles. An arbitrary manual or older fetched mark without a matching receipt does not prove the provider request was resolved.

Changing a subject's binding or effective route creates a different request identity. New subjects fetch independently. Failed needs receive no successful receipt, so retrying does not repeat completed work. A crash after saving a mark but before its receipt can cause another request, but cannot create a false cache hit.

The refresh lock serializes complete refresh operations across processes. The book lock protects local commits and is released during network waits. A caller finding an active refresh fails fast rather than starting duplicate network work. Abandoned or uncertain book and refresh locks remain in place and stop work for manual recovery; acquisition never removes another owner's lock.

## Resolve manual conflicts explicitly

Provider candidates are saved even when a same-date manual mark takes precedence. The refresh report includes differing manual and fetched values. By default the manual mark remains selected.

Explicit replacement compares the manual records read before the request with those present at commit. A concurrent change fails with a conflict. Otherwise the core file adapter removes those same-date manual marks and keeps the accepted provider candidate selected. A later invocation can accept a cached candidate without another provider request. Marks on other dates and transaction history remain untouched.

## Preserve partial progress

`packages/market-data/src/coordinator.ts::MarketDataCoordinator.resolvePrices` and `packages/market-data/src/coordinator.ts::MarketDataCoordinator.resolveFxRates` deduplicate requested needs and reuse matching resolution receipts.

Compatible pending needs are grouped by provider. Each valid observation is appended immediately through the store before the coordinator advances to the next work.

Default route lists can fall through to their next provider after a failed outcome. Exhausted and unrouteable needs remain explicit failures with the provider and normalized failure kind.

A storage failure stops resolution because the subsystem cannot claim the observation was saved. A provider failure does not discard observations already appended.

The shared refresh operation reloads the book after fetching and manual-conflict handling. The CLI derives the partial or complete view from this persisted snapshot. An incomplete fetch exits as an external failure while still returning the useful view and counts of requested and saved work.

## Normalize failures

Provider failures use the stable categories defined by `packages/market-data/src/contracts.ts::ProviderFailureKind`: unsupported, not found, rate limited, unauthorized, unavailable, or invalid response.

Adapters validate response structure and semantic fields before constructing an observation. A provider returning the wrong subject, currency, pair, date direction, or provenance is an invalid response.

`packages/market-data/src/http.ts::createRetryingFetch` centralizes bounded retries for providers where an automatic retry is appropriate and respects acceptable `Retry-After` values. EODHD deliberately performs one bounded request without retrying so a fetch has predictable cost against a small daily quota.

Provider SDKs and response shapes stay inside their adapters. No raw provider response is written to the book.

## Test without live providers

Adapter tests use captured fixtures, injected gateways, and local fetch behaviour. The normal repository gate makes no live network request.

Coordinator tests use controlled sources and temporary books to cover routing, batching, fallback, cycle boundaries, restart reuse, exact-date historical reuse, response validation, incremental persistence, interruption, concurrency, and manual-conflict acceptance.

Configuration tests exercise schema validation and the real temporary filesystem. Built-CLI tests use a Node preload fixture at the HTTP boundary to exercise fetching, warnings, JSON, partial failure, and cached acceptance without a live network connection. Historical event-rate tests remain separate.
