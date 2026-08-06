-- AlterTable
ALTER TABLE `stock_movements` ADD COLUMN `batchId` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `stock_batches` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `branchId` VARCHAR(191) NULL,
    `batchNo` VARCHAR(60) NULL,
    `expiresAt` DATE NULL,
    `qty` DECIMAL(12, 3) NOT NULL DEFAULT 0.000,
    `unitCost` DECIMAL(12, 2) NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `stock_batches_orgId_productId_branchId_expiresAt_idx`(`orgId`, `productId`, `branchId`, `expiresAt`),
    INDEX `stock_batches_orgId_expiresAt_idx`(`orgId`, `expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `stock_movements_batchId_idx` ON `stock_movements`(`batchId`);

-- AddForeignKey
ALTER TABLE `stock_batches` ADD CONSTRAINT `stock_batches_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_batches` ADD CONSTRAINT `stock_batches_branchId_fkey` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_movements` ADD CONSTRAINT `stock_movements_batchId_fkey` FOREIGN KEY (`batchId`) REFERENCES `stock_batches`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
