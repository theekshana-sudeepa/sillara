-- CreateTable
CREATE TABLE `rate_limit_hits` (
    `key` VARCHAR(191) NOT NULL,
    `count` INTEGER NOT NULL DEFAULT 0,
    `expiresAt` DATETIME(3) NOT NULL,

    INDEX `rate_limit_hits_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- RenameIndex
ALTER TABLE `shifts` RENAME INDEX `uniq_open_shift_per_register` TO `shifts_orgId_openRegisterKey_key`;
