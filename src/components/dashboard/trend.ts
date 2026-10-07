/**
 * Small series for sparklines. Anchored to the newest item in the data, not to
 * "now", so the server render and the browser render agree (a clock-based
 * window would differ between them and trip hydration).
 */
const DAY = 86_400_000;

export function dailyTotals<T>(items: T[], time: (t: T) => string, value: (t: T) => number, days = 14): number[] {
  if (items.length === 0) return [];
  const times = items.map((i) => new Date(time(i)).getTime());
  const end = Math.max(...times);
  const out = new Array<number>(days).fill(0);
  items.forEach((item, i) => {
    const back = Math.floor((end - times[i]) / DAY);
    if (back >= 0 && back < days) out[days - 1 - back] += value(item);
  });
  return out;
}

export function cumulative(series: number[]): number[] {
  let sum = 0;
  return series.map((v) => (sum += v));
}
