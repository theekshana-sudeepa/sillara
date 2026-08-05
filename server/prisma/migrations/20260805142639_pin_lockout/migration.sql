-- AlterTable
ALTER TABLE `org_users` ADD COLUMN `pinFailedAttempts` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `pinLockedUntil` DATETIME(3) NULL;
