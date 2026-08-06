-- AlterTable
ALTER TABLE `products` ADD COLUMN `parentId` VARCHAR(191) NULL,
    ADD COLUMN `variantAttributes` JSON NULL,
    ADD COLUMN `variantOptions` JSON NULL;

-- CreateIndex
CREATE INDEX `products_orgId_parentId_idx` ON `products`(`orgId`, `parentId`);

-- AddForeignKey
ALTER TABLE `products` ADD CONSTRAINT `products_parentId_fkey` FOREIGN KEY (`parentId`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
