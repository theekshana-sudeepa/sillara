import { describe, it, expect } from 'vitest';
import { localDay, localDayOf, localDateString, localTimeString, formatDayLabel, tzOffsetMs } from './time.js';

/**
 * A Colombo shop's trading day ends at Colombo midnight. Getting this wrong
 * splits their evening across two reports, and an owner who catches you
 * reporting the wrong takings never trusts another number you show them.
 */

describe('tzOffsetMs', () => {
  it('reads Colombo as UTC+5:30', () => {
    expect(tzOffsetMs('Asia/Colombo', new Date('2026-08-01T00:00:00Z'))).toBe(5.5 * 3_600_000);
  });

  it('reads UTC as zero', () => {
    expect(tzOffsetMs('UTC', new Date('2026-08-01T00:00:00Z'))).toBe(0);
  });

  it('follows a DST zone across the switch', () => {
    expect(tzOffsetMs('Europe/London', new Date('2026-01-15T12:00:00Z'))).toBe(0);
    expect(tzOffsetMs('Europe/London', new Date('2026-07-15T12:00:00Z'))).toBe(3_600_000);
  });
});

describe('localDay', () => {
  it('gives yesterday in Colombo, not yesterday in UTC', () => {
    // 01 Aug 02:00 UTC is already 07:30 on 01 Aug in Colombo, so "yesterday"
    // there is 31 July — which began at 18:30 UTC on 30 July.
    const day = localDay('Asia/Colombo', new Date('2026-08-01T02:00:00Z'), -1);
    expect(day.date).toBe('2026-07-31');
    expect(day.start.toISOString()).toBe('2026-07-30T18:30:00.000Z');
    expect(day.end.toISOString()).toBe('2026-07-31T18:30:00.000Z');
  });

  it('spans exactly 24 hours', () => {
    const day = localDay('Asia/Colombo', new Date('2026-08-01T02:00:00Z'), -1);
    expect(day.end.getTime() - day.start.getTime()).toBe(86_400_000);
  });

  it('handles a shop west of UTC', () => {
    // 01 Aug 02:00 UTC is still 31 July in New York, so "today" there is 31 July.
    const day = localDay('America/New_York', new Date('2026-08-01T02:00:00Z'), 0);
    expect(day.date).toBe('2026-07-31');
  });

  it('gives today when the offset is zero', () => {
    expect(localDay('UTC', new Date('2026-08-01T02:00:00Z'), 0).date).toBe('2026-08-01');
  });

  it('rolls back across a month boundary', () => {
    expect(localDay('UTC', new Date('2026-08-01T02:00:00Z'), -1).date).toBe('2026-07-31');
  });
});

describe('formatDayLabel', () => {
  it('reads like a date a human wrote', () => {
    expect(formatDayLabel('2026-07-31')).toBe('31 July 2026');
  });
});

describe('localDayOf — a named calendar date, in the shop’s own timezone', () => {
  it('starts Colombo’s 1st of August at 18:30 UTC on the 31st', () => {
    const day = localDayOf('Asia/Colombo', '2026-08-01');
    expect(day.start.toISOString()).toBe('2026-07-31T18:30:00.000Z');
    expect(day.end.toISOString()).toBe('2026-08-01T18:30:00.000Z');
    expect(day.date).toBe('2026-08-01');
  });

  it('agrees with localDay for the day that contains a given instant', () => {
    // 9pm in Colombo, which is still the 1st there but the 1st at 15:30 UTC.
    const evening = new Date('2026-08-01T15:30:00.000Z');
    const fromInstant = localDay('Asia/Colombo', evening);
    const fromDate = localDayOf('Asia/Colombo', fromInstant.date);
    expect(fromDate.start.toISOString()).toBe(fromInstant.start.toISOString());
    expect(fromDate.end.toISOString()).toBe(fromInstant.end.toISOString());
  });

  it('handles a zone behind UTC', () => {
    const day = localDayOf('America/New_York', '2026-08-01');
    expect(day.start.toISOString()).toBe('2026-08-01T04:00:00.000Z'); // EDT, UTC-4
  });

  it('renders local date and time rather than UTC', () => {
    // 22:00 in Colombo is 16:30 UTC — the UTC date is the same here, but the
    // hour on a receipt must read as the cashier experienced it.
    const at = new Date('2026-08-01T16:30:00.000Z');
    expect(localDateString('Asia/Colombo', at)).toBe('2026-08-01');
    expect(localTimeString('Asia/Colombo', at)).toBe('22:00:00');

    // And an hour later it is tomorrow in Colombo while still the 1st in UTC.
    const late = new Date('2026-08-01T19:00:00.000Z');
    expect(localDateString('Asia/Colombo', late)).toBe('2026-08-02');
  });
});
