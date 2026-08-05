/**
 * Timezone helpers.
 *
 * A shop in Colombo closes at 10pm Colombo time. If the daily digest used UTC
 * day boundaries it would cut their evening in half and report the wrong
 * takings — the single fastest way to lose an owner's trust in your numbers.
 * So every "day" in reporting is the org's local day.
 *
 * Built on Intl rather than a date library: Node ships the full IANA database,
 * and this is four lines of arithmetic.
 */

/** Milliseconds to add to a UTC instant to read it as wall-clock time in `tz`. */
export function tzOffsetMs(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asIfUtc - Math.floor(at.getTime() / 1000) * 1000;
}

export interface DayRange {
  /** Inclusive start, as a UTC instant. */
  start: Date;
  /** Exclusive end, as a UTC instant. */
  end: Date;
  /** The local calendar date, e.g. "2026-08-01". */
  date: string;
}

/**
 * The org-local calendar day containing `now`, shifted by `offsetDays`
 * (`-1` = yesterday), expressed as UTC instants for querying.
 *
 * DST caveat: the offset is sampled once at `now`. For a shop in a zone that
 * shifts overnight this can be an hour out at the boundary; every market
 * Sillara launches into (LK, IN, AE, SG, most of Africa) has no DST, and the
 * fix when that changes is to sample the offset at the computed midnight and
 * re-solve once.
 */
export function localDay(timeZone: string, now: Date, offsetDays = 0): DayRange {
  const offset = tzOffsetMs(timeZone, now);
  const local = new Date(now.getTime() + offset);

  const midnightLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + offsetDays);
  const start = new Date(midnightLocal - offset);
  const end = new Date(start.getTime() + 86_400_000);

  return { start, end, date: new Date(midnightLocal).toISOString().slice(0, 10) };
}

/**
 * The org-local day for a specific calendar date, e.g. "2026-08-01".
 *
 * `localDay` answers "what day is it there now?"; this answers "when did their
 * 1st of August begin and end?", which is what a report for a named date needs.
 * Same single-sample offset approach, same DST caveat.
 */
export function localDayOf(timeZone: string, isoDate: string): DayRange {
  const [y, m, d] = isoDate.split('-').map(Number);
  const midnightUtc = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  const offset = tzOffsetMs(timeZone, new Date(midnightUtc));
  const start = new Date(midnightUtc - offset);

  return { start, end: new Date(start.getTime() + 86_400_000), date: isoDate };
}

/** The org-local calendar date of a UTC instant — what a receipt should show. */
export function localDateString(timeZone: string, at: Date): string {
  return new Date(at.getTime() + tzOffsetMs(timeZone, at)).toISOString().slice(0, 10);
}

/** The org-local wall-clock time of a UTC instant, "14:32:05". */
export function localTimeString(timeZone: string, at: Date): string {
  return new Date(at.getTime() + tzOffsetMs(timeZone, at)).toISOString().slice(11, 19);
}

/** "1 August 2026" in the org's language — the subject line of the digest. */
export function formatDayLabel(date: string, locale = 'en-GB'): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)),
  );
}
