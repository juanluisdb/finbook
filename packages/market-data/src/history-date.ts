export function completedHistoryDate(now: Date): string {
  return new Date(now.getTime() - (24 + 6) * 60 * 60 * 1000).toISOString().slice(0, 10);
}
