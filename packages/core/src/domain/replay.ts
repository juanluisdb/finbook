import { apply } from "./apply.js";
import { fail, succeed, type Result } from "./result.js";
import type { Event } from "./schemas.js";
import type { BookState } from "./state.js";

export function orderEvents(events: readonly Event[]): readonly Event[] {
  return events
    .map((event, sequence) => ({ event, sequence }))
    .sort((left, right) => {
      const dateOrder = left.event.date.localeCompare(right.event.date);
      return dateOrder === 0 ? left.sequence - right.sequence : dateOrder;
    })
    .map(({ event }) => event);
}

export function replayEvents(
  initialState: BookState,
  events: readonly Event[],
  asOf?: string,
): Result<BookState> {
  let state = initialState;
  for (const event of orderEvents(events)) {
    if (asOf !== undefined && event.date > asOf) continue;
    const result = apply(state, event);
    if (!result.ok) return fail(result.error);
    state = result.data;
  }
  return succeed(state);
}
