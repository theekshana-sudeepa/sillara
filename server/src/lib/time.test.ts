import { describe, it, expect } from 'vitest';
import { localDay, formatDayLabel, tzOffsetMs } from './time.js';

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
