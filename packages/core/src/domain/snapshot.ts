import type { Account, Event, FxStamp, Instrument, PriceStamp } from "./schemas.js";

export type BookSnapshot = {
  accounts: readonly Account[];
  instruments: readonly Instrument[];
  events: readonly Event[];
  prices: readonly PriceStamp[];
  fx: readonly FxStamp[];
};
