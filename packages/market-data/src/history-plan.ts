import {
  getPositions,
  succeed,
  type BookSnapshot,
  type Instrument,
  type Result,
} from "@finbook/core";

export type DateRange = { from: string; through: string };
export type HistoryRequirement = DateRange &
  ({ kind: "price"; subject: string; instrument: Instrument } | { kind: "fx"; subject: string });

export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function historyRequirements(
  snapshot: BookSnapshot,
  through: string,
): Result<readonly HistoryRequirement[]> {
  const dates = [
    ...new Set(snapshot.events.map((event) => event.date).filter((date) => date <= through)),
  ].sort();
  const bySubject = new Map<string, HistoryRequirement[]>();
  for (const [index, from] of dates.entries()) {
    const next = dates[index + 1];
    const end = next === undefined ? through : shiftDate(next, -1);
    const state = getPositions(snapshot, from);
    if (!state.ok) return state;
    const currencies = new Set(state.data.cash.map((cash) => cash.currency));
    const held = new Set(state.data.positions.map((position) => position.instrument));
    for (const instrument of snapshot.instruments) {
      if (!held.has(instrument.id)) continue;
      addRequirement(bySubject, {
        kind: "price",
        subject: instrument.id,
        instrument,
        from,
        through: end,
      });
      currencies.add(instrument.quoteCurrency);
    }
    for (const currency of currencies) {
      if (currency !== "EUR")
        addRequirement(bySubject, { kind: "fx", subject: currency, from, through: end });
    }
  }
  return succeed([...bySubject.values()].flat());
}

function addRequirement(
  bySubject: Map<string, HistoryRequirement[]>,
  requirement: HistoryRequirement,
): void {
  const key = `${requirement.kind}:${requirement.subject}`;
  const ranges = bySubject.get(key) ?? [];
  const last = ranges.at(-1);
  if (last !== undefined && shiftDate(last.through, 1) === requirement.from)
    last.through = requirement.through;
  else ranges.push(requirement);
  bySubject.set(key, ranges);
}

export function uncheckedRanges(range: DateRange, checked: readonly DateRange[]): DateRange[] {
  let remaining: DateRange[] = [range];
  for (const covered of checked) {
    remaining = remaining.flatMap((part) => {
      if (covered.through < part.from || covered.from > part.through) return [part];
      const pieces: DateRange[] = [];
      if (covered.from > part.from)
        pieces.push({ from: part.from, through: shiftDate(covered.from, -1) });
      if (covered.through < part.through)
        pieces.push({ from: shiftDate(covered.through, 1), through: part.through });
      return pieces;
    });
  }
  return remaining;
}

export function retainHistory<T extends { asOf: string }>(
  observations: readonly T[],
  range: DateRange,
): T[] {
  const inRange = observations.filter(
    (mark) => mark.asOf >= range.from && mark.asOf <= range.through,
  );
  const predecessor = observations
    .filter((mark) => mark.asOf < range.from)
    .sort((a, b) => b.asOf.localeCompare(a.asOf))[0];
  return (predecessor === undefined ? inRange : [predecessor, ...inRange]).sort((a, b) =>
    a.asOf.localeCompare(b.asOf),
  );
}
