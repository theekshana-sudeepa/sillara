-- One open shift per register, enforced by the database.
--
-- Opening a shift used to be a check-then-create with nothing underneath it:
-- two tills hitting it at the same moment both found no open shift and both
-- created one. The day's sales then split across two shifts, each of which
-- counted the wrong cash at close, and the variance pointed at nobody.
--
-- MySQL has no partial indexes, so the key is a column that is only populated
-- while the shift is open: the register id (or a sentinel when a till has no
-- register) while OPEN, NULL once CLOSED. MySQL treats NULLs as distinct in a
-- UNIQUE index, so this permits any number of closed shifts and exactly one
-- open one per register.
--
-- The column is maintained by the application rather than being GENERATED,
-- because a generated column cannot be expressed in the Prisma schema and
-- would show up as drift on every future `migrate dev`. The failure mode of
-- forgetting to clear it is loud — the register cannot open a new shift —
-- rather than silent, which is the right direction for a cash control.
ALTER TABLE `shifts` ADD COLUMN `openRegisterKey` VARCHAR(191) NULL;

-- Backfill: currently-open shifts take their key, closed ones stay NULL.
UPDATE `shifts`
SET `openRegisterKey` = COALESCE(`registerId`, '__no_register__')
WHERE `status` = 'OPEN';

-- Any org that already has two open shifts on one register would block this.
-- Keep the most recently opened and close the rest, recording why.
UPDATE `shifts` s
JOIN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY orgId, COALESCE(registerId, '__no_register__')
      ORDER BY openedAt DESC
    ) AS rn
    FROM `shifts` WHERE status = 'OPEN'
  ) ranked WHERE rn > 1
) dupes ON dupes.id = s.id
SET s.status = 'CLOSED',
    s.closedAt = UTC_TIMESTAMP(3),
    s.openRegisterKey = NULL,
    s.note = CONCAT(COALESCE(s.note, ''), ' [auto-closed: duplicate open shift on this register]');

CREATE UNIQUE INDEX `uniq_open_shift_per_register` ON `shifts`(`orgId`, `openRegisterKey`);
