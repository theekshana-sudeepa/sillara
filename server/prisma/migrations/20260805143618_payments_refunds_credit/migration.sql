-- AlterTable
ALTER TABLE `sale_items` ADD COLUMN `originalItemId` VARCHAR(191) NULL,
    ADD COLUMN `refundedQty` DECIMAL(12, 3) NOT NULL DEFAULT 0.000;

-- AlterTable
ALTER TABLE `sales` ADD COLUMN `kind` ENUM('SALE', 'REFUND') NOT NULL DEFAULT 'SALE',
    ADD COLUMN `originalSaleId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `stock_movements` MODIFY `type` ENUM('SALE', 'VOID_RETURN', 'REFUND_RETURN', 'RECEIVE', 'ADJUST', 'COUNT', 'TRANSFER_IN', 'TRANSFER_OUT') NOT NULL;

-- CreateTable
CREATE TABLE `sale_payments` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `saleId` VARCHAR(191) NOT NULL,
    `type` ENUM('CASH', 'CARD', 'QR', 'CREDIT', 'OTHER') NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `tendered` DECIMAL(12, 2) NULL,
    `change` DECIMAL(12, 2) NULL,
    `reference` VARCHAR(80) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `sale_payments_saleId_idx`(`saleId`),
    INDEX `sale_payments_orgId_type_createdAt_idx`(`orgId`, `type`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_credit_transactions` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `saleId` VARCHAR(191) NULL,
    `type` ENUM('CHARGE', 'SETTLE', 'ADJUST') NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `method` ENUM('CASH', 'CARD', 'QR', 'CREDIT', 'OTHER') NULL,
    `note` VARCHAR(255) NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `customer_credit_transactions_orgId_customerId_createdAt_idx`(`orgId`, `customerId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `sales_originalSaleId_idx` ON `sales`(`originalSaleId`);

-- AddForeignKey
ALTER TABLE `sales` ADD CONSTRAINT `sales_originalSaleId_fkey` FOREIGN KEY (`originalSaleId`) REFERENCES `sales`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sale_payments` ADD CONSTRAINT `sale_payments_saleId_fkey` FOREIGN KEY (`saleId`) REFERENCES `sales`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_credit_transactions` ADD CONSTRAINT `customer_credit_transactions_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_credit_transactions` ADD CONSTRAINT `customer_credit_transactions_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_credit_transactions` ADD CONSTRAINT `customer_credit_transactions_saleId_fkey` FOREIGN KEY (`saleId`) REFERENCES `sales`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: every sale that already exists becomes one payment row for its
-- single tender. Without this, `Σ payments == total` is false for all history
-- and the Z-report — which now reads from sale_payments — would show a day of
-- past trading as zero takings.
--
-- Ids are prefixed so a backfilled row is distinguishable from one the
-- application wrote. Voided sales are included: the payment happened, and the
-- void is recorded separately by status.
INSERT INTO `sale_payments` (`id`, `orgId`, `saleId`, `type`, `amount`, `tendered`, `change`, `createdAt`)
SELECT CONCAT('bkfp_', REPLACE(UUID(), '-', '')),
       s.orgId,
       s.id,
       s.tender,
       s.total,
       CASE WHEN s.tender = 'CASH' THEN s.tendered ELSE NULL END,
       CASE WHEN s.tender = 'CASH' THEN s.change   ELSE NULL END,
       s.syncedAt
FROM `sales` s
LEFT JOIN `sale_payments` p ON p.saleId = s.id
WHERE p.id IS NULL
  -- A bill that came to nothing (settled entirely in loyalty points, or
  -- discounted to zero) has no payment to record. Matches what the
  -- application now writes, so history and new rows agree.
  AND s.total <> 0;
