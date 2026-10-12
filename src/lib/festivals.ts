/**
 * Festival-aware lead times.
 *
 * Around the big festivals Indian suppliers close, run short-staffed or ship late,
 * so a restock that needs 7 days in March can need 11 in the week before Diwali.
 * When the merchant switches this on, the days below are added to every supplier's
 * lead time while a festival is close, so the restock is asked for earlier.
 *
 * A static list, on purpose: no service to call, nothing to go down. Dates of
 * festivals that follow the lunar calendar are approximate (they can move by a day
 * or two), which is fine for a buffer measured in days. Extend the list yearly.
 */

export interface Festival {
  name: string;
  /** YYYY-MM-DD, India. */
  date: string;
}

export const FESTIVALS: Festival[] = [
  { name: "Dussehra", date: "2026-10-20" },
  { name: "Diwali", date: "2026-11-08" },
  { name: "Christmas", date: "2026-12-25" },
  { name: "Makar Sankranti", date: "2027-01-14" },
  { name: "Eid al-Fitr", date: "2027-03-10" },
  { name: "Holi", date: "2027-03-22" },
  { name: "Dussehra", date: "2027-10-19" },
  { name: "Diwali", date: "2027-10-29" },
  { name: "Christmas", date: "2027-12-25" },
];

/** Days before a festival when suppliers start to slow, and after it while they reopen. */
const RUN_UP_DAYS = 21;
const REOPEN_DAYS = 5;
const RUN_UP_BUFFER = 4;
const REOPEN_BUFFER = 3;
const DAY = 86_400_000;

const dayNumber = (d: Date) => Math.floor((d.getTime() + 5.5 * 3600_000) / DAY);
const festivalDay = (f: Festival) => Math.floor(new Date(`${f.date}T00:00:00Z`).getTime() / DAY);

export function festivalBufferDays(now: Date): { days: number; reason: string | null } {
  const today = dayNumber(now);
  let best = { days: 0, reason: null as string | null };
  for (const f of FESTIVALS) {
    const away = festivalDay(f) - today;
    let days = 0;
    let reason: string | null = null;
    if (away >= 0 && away <= RUN_UP_DAYS) {
      days = RUN_UP_BUFFER;
      reason = `${f.name} is ${away === 0 ? "today" : `${away} day${away === 1 ? "" : "s"} away`}, so suppliers are slower`;
    } else if (away < 0 && -away <= REOPEN_DAYS) {
      days = REOPEN_BUFFER;
      reason = `${f.name} has just passed, and suppliers are reopening`;
    }
    if (days > best.days) best = { days, reason };
  }
  return best;
}

export const effectiveLeadDays = (base: number, now: Date) => base + festivalBufferDays(now).days;
