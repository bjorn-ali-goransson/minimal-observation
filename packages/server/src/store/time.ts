/** Server-local day/hour helpers. Partitioning is by the server's local calendar day. */

export function dayOf(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function today(): string {
  return dayOf(Date.now());
}

/** Local-midnight epoch-ms of the day that `ms` falls in. */
export function dayStartMs(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function nextMidnightMs(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

/** Inclusive list of local day strings spanned by [fromMs, toMs], capped to `maxDays`. */
export function daysBetween(fromMs: number, toMs: number, maxDays = 8): string[] {
  const days: string[] = [];
  let cur = dayStartMs(fromMs);
  const end = dayStartMs(toMs);
  while (cur <= end && days.length < maxDays) {
    days.push(dayOf(cur));
    cur = nextMidnightMs(cur);
  }
  return days;
}

export const relTableForDay = (day: string) => `d_${day.replace(/-/g, '_')}`;
