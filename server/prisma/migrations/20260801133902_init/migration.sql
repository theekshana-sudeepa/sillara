-- CreateTable
CREATE TABLE `Plan` (
    `code` ENUM('FREE', 'SHOP', 'PRO') NOT NULL,
    `name` VARCHAR(60) NOT NULL,
    `priceUsd` DECIMAL(8, 2) NOT NULL,
    `priceLkr` DECIMAL(10, 2) NOT NULL,
    `maxTerminals` INTEGER NOT NULL,
    `maxProducts` INTEGER NOT NULL,
    `maxUsers` INTEGER NOT NULL,
    `features` JSON NOT NULL,
    `paddlePriceId` VARCHAR(120) NULL,
    `payherePlanId` VARCHAR(120) NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`code`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `organizations` (
    `id` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(60) NOT NULL,
    `name` VARCHAR(180) NOT NULL,
    `country` VARCHAR(2) NOT NULL DEFAULT 'LK',
    `currency` VARCHAR(3) NOT NULL DEFAULT 'LKR',
    `timezone` VARCHAR(64) NOT NULL DEFAULT 'Asia/Colombo',
    `language` VARCHAR(5) NOT NULL DEFAULT 'en',
    `status` ENUM('PENDING', 'TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `planCode` ENUM('FREE', 'SHOP', 'PRO') NOT NULL DEFAULT 'FREE',
    `billingProvider` ENUM('PADDLE', 'PAYHERE', 'MANUAL') NOT NULL DEFAULT 'MANUAL',
    `billingRef` VARCHAR(191) NULL,
    `trialEndsAt` DATETIME(3) NULL,
    `provisionedAt` DATETIME(3) NULL,
    `suspendedAt` DATETIME(3) NULL,
    `currentPeriodEnd` DATETIME(3) NULL,
    `graceUntil` DATETIME(3) NULL,
    `lastBillingEmailAt` DATETIME(3) NULL,
    `dailyDigestEnabled` BOOLEAN NOT NULL DEFAULT true,
    `receiptHeader` VARCHAR(255) NULL,
    `receiptFooter` VARCHAR(255) NULL,
    `address` VARCHAR(255) NULL,
    `phone` VARCHAR(40) NULL,
    `taxId` VARCHAR(60) NULL,
    `taxRate` DECIMAL(5, 2) NOT NULL DEFAULT 0.00,
    `taxInclusive` BOOLEAN NOT NULL DEFAULT true,
    `loyaltyEnabled` BOOLEAN NOT NULL DEFAULT false,
    `loyaltyEarnRate` DECIMAL(8, 4) NOT NULL DEFAULT 1.0000,
    `loyaltyRedeemValue` DECIMAL(8, 4) NOT NULL DEFAULT 0.0100,
    `loyaltyMinRedeem` INTEGER NOT NULL DEFAULT 100,
    `referralCode` VARCHAR(16) NULL,
    `referredByOrgId` VARCHAR(32) NULL,
    `creditMonths` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `organizations_slug_key`(`slug`),
    UNIQUE INDEX `organizations_referralCode_key`(`referralCode`),
    INDEX `organizations_status_idx`(`status`),
    INDEX `organizations_planCode_idx`(`planCode`),
    INDEX `organizations_status_currentPeriodEnd_idx`(`status`, `currentPeriodEnd`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `branches` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `code` VARCHAR(16) NOT NULL,
    `address` VARCHAR(255) NULL,
    `phone` VARCHAR(40) NULL,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `branches_orgId_isActive_idx`(`orgId`, `isActive`),
    UNIQUE INDEX `branches_orgId_code_key`(`orgId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `branch_stock` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `branchId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `qty` DECIMAL(12, 3) NOT NULL DEFAULT 0.000,
    `lowStockAt` DECIMAL(12, 3) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `branch_stock_orgId_productId_idx`(`orgId`, `productId`),
    UNIQUE INDEX `branch_stock_branchId_productId_key`(`branchId`, `productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `org_users` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `role` ENUM('OWNER', 'MANAGER', 'CASHIER') NOT NULL DEFAULT 'CASHIER',
    `passwordHash` VARCHAR(255) NULL,
    `pin` VARCHAR(255) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `lastLoginAt` DATETIME(3) NULL,
    `magicToken` VARCHAR(64) NULL,
    `magicExpiresAt` DATETIME(3) NULL,
    `branchId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `org_users_magicToken_key`(`magicToken`),
    INDEX `org_users_email_idx`(`email`),
    UNIQUE INDEX `org_users_orgId_email_key`(`orgId`, `email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `webhook_events` (
    `id` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(20) NOT NULL,
    `eventId` VARCHAR(191) NOT NULL,
    `eventType` VARCHAR(80) NOT NULL,
    `payload` JSON NOT NULL,
    `processedAt` DATETIME(3) NULL,
    `error` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `webhook_events_createdAt_idx`(`createdAt`),
    UNIQUE INDEX `webhook_events_provider_eventId_key`(`provider`, `eventId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `categories` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `color` VARCHAR(9) NOT NULL DEFAULT '#6366F1',
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `categories_orgId_name_key`(`orgId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `products` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `categoryId` VARCHAR(191) NULL,
    `sku` VARCHAR(60) NULL,
    `barcode` VARCHAR(60) NULL,
    `name` VARCHAR(180) NOT NULL,
    `price` DECIMAL(12, 2) NOT NULL,
    `cost` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `taxRate` DECIMAL(5, 2) NULL,
    `trackStock` BOOLEAN NOT NULL DEFAULT false,
    `stockQty` DECIMAL(12, 3) NOT NULL DEFAULT 0.000,
    `lowStockAt` DECIMAL(12, 3) NULL,
    `unit` VARCHAR(12) NOT NULL DEFAULT 'pc',
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `products_orgId_barcode_idx`(`orgId`, `barcode`),
    INDEX `products_orgId_isActive_deletedAt_idx`(`orgId`, `isActive`, `deletedAt`),
    UNIQUE INDEX `products_orgId_sku_key`(`orgId`, `sku`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customers` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `phone` VARCHAR(40) NULL,
    `email` VARCHAR(191) NULL,
    `loyaltyPoints` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `creditBalance` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `customers_orgId_phone_idx`(`orgId`, `phone`),
    INDEX `customers_orgId_name_idx`(`orgId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `registers` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `branchId` VARCHAR(191) NULL,
    `name` VARCHAR(60) NOT NULL,
    `deviceId` VARCHAR(120) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `registers_orgId_name_key`(`orgId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sales` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `branchId` VARCHAR(191) NULL,
    `shiftId` VARCHAR(191) NULL,
    `registerId` VARCHAR(191) NULL,
    `cashierId` VARCHAR(191) NULL,
    `customerId` VARCHAR(191) NULL,
    `clientUuid` VARCHAR(36) NOT NULL,
    `publicId` VARCHAR(24) NULL,
    `number` INTEGER NOT NULL,
    `status` ENUM('COMPLETED', 'VOID') NOT NULL DEFAULT 'COMPLETED',
    `currency` VARCHAR(3) NOT NULL,
    `subtotal` DECIMAL(12, 2) NOT NULL,
    `discount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `tax` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `total` DECIMAL(12, 2) NOT NULL,
    `tendered` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `change` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `tender` ENUM('CASH', 'CARD', 'QR', 'CREDIT', 'OTHER') NOT NULL DEFAULT 'CASH',
    `pointsEarned` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `pointsRedeemed` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `loyaltyDiscount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `note` VARCHAR(255) NULL,
    `soldAt` DATETIME(3) NOT NULL,
    `syncedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `voidedAt` DATETIME(3) NULL,
    `voidReason` VARCHAR(255) NULL,

    UNIQUE INDEX `sales_publicId_key`(`publicId`),
    INDEX `sales_orgId_soldAt_idx`(`orgId`, `soldAt`),
    INDEX `sales_orgId_branchId_soldAt_idx`(`orgId`, `branchId`, `soldAt`),
    INDEX `sales_shiftId_idx`(`shiftId`),
    INDEX `sales_orgId_status_soldAt_idx`(`orgId`, `status`, `soldAt`),
    UNIQUE INDEX `sales_orgId_clientUuid_key`(`orgId`, `clientUuid`),
    UNIQUE INDEX `sales_orgId_number_key`(`orgId`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sale_items` (
    `id` VARCHAR(191) NOT NULL,
    `saleId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NULL,
    `nameSnapshot` VARCHAR(180) NOT NULL,
    `unitPrice` DECIMAL(12, 2) NOT NULL,
    `qty` DECIMAL(12, 3) NOT NULL,
    `taxRate` DECIMAL(5, 2) NOT NULL DEFAULT 0.00,
    `lineDiscount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `lineTotal` DECIMAL(12, 2) NOT NULL,

    INDEX `sale_items_saleId_idx`(`saleId`),
    INDEX `sale_items_productId_idx`(`productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_movements` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `branchId` VARCHAR(191) NULL,
    `productId` VARCHAR(191) NOT NULL,
    `type` ENUM('SALE', 'VOID_RETURN', 'RECEIVE', 'ADJUST', 'COUNT', 'TRANSFER_IN', 'TRANSFER_OUT') NOT NULL,
    `qty` DECIMAL(12, 3) NOT NULL,
    `unitCost` DECIMAL(12, 2) NULL,
    `note` VARCHAR(255) NULL,
    `refType` VARCHAR(20) NULL,
    `refId` VARCHAR(64) NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `stock_movements_orgId_productId_createdAt_idx`(`orgId`, `productId`, `createdAt`),
    INDEX `stock_movements_orgId_branchId_createdAt_idx`(`orgId`, `branchId`, `createdAt`),
    INDEX `stock_movements_orgId_type_createdAt_idx`(`orgId`, `type`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shifts` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `branchId` VARCHAR(191) NULL,
    `registerId` VARCHAR(191) NULL,
    `status` ENUM('OPEN', 'CLOSED') NOT NULL DEFAULT 'OPEN',
    `openingFloat` DECIMAL(12, 2) NOT NULL,
    `expectedCash` DECIMAL(12, 2) NULL,
    `countedCash` DECIMAL(12, 2) NULL,
    `variance` DECIMAL(12, 2) NULL,
    `openedById` VARCHAR(191) NULL,
    `closedById` VARCHAR(191) NULL,
    `openedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `closedAt` DATETIME(3) NULL,
    `note` VARCHAR(255) NULL,

    INDEX `shifts_orgId_status_idx`(`orgId`, `status`),
    INDEX `shifts_orgId_openedAt_idx`(`orgId`, `openedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `loyalty_transactions` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `saleId` VARCHAR(191) NULL,
    `type` ENUM('EARN', 'REDEEM', 'ADJUST', 'EXPIRE') NOT NULL,
    `points` DECIMAL(12, 2) NOT NULL,
    `value` DECIMAL(12, 2) NULL,
    `note` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `loyalty_transactions_orgId_customerId_createdAt_idx`(`orgId`, `customerId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `suppliers` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(180) NOT NULL,
    `phone` VARCHAR(40) NULL,
    `email` VARCHAR(191) NULL,
    `address` VARCHAR(255) NULL,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `suppliers_orgId_name_key`(`orgId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `purchase_orders` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `branchId` VARCHAR(191) NULL,
    `supplierId` VARCHAR(191) NULL,
    `supplierAccountId` VARCHAR(191) NULL,
    `number` INTEGER NOT NULL,
    `status` ENUM('DRAFT', 'SENT', 'PARTIAL', 'RECEIVED', 'CANCELLED') NOT NULL DEFAULT 'DRAFT',
    `currency` VARCHAR(3) NOT NULL,
    `total` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `expectedAt` DATE NULL,
    `notes` TEXT NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `sentAt` DATETIME(3) NULL,
    `confirmedAt` DATETIME(3) NULL,
    `receivedAt` DATETIME(3) NULL,

    INDEX `purchase_orders_orgId_status_idx`(`orgId`, `status`),
    INDEX `purchase_orders_supplierAccountId_status_idx`(`supplierAccountId`, `status`),
    UNIQUE INDEX `purchase_orders_orgId_number_key`(`orgId`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `purchase_order_items` (
    `id` VARCHAR(191) NOT NULL,
    `purchaseOrderId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NULL,
    `supplierProductId` VARCHAR(191) NULL,
    `nameSnapshot` VARCHAR(180) NOT NULL,
    `qty` DECIMAL(12, 3) NOT NULL,
    `qtyReceived` DECIMAL(12, 3) NOT NULL DEFAULT 0.000,
    `unitCost` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,

    INDEX `purchase_order_items_purchaseOrderId_idx`(`purchaseOrderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `supplier_accounts` (
    `id` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(80) NOT NULL,
    `name` VARCHAR(180) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(40) NULL,
    `country` VARCHAR(2) NOT NULL DEFAULT 'LK',
    `currency` VARCHAR(3) NOT NULL DEFAULT 'LKR',
    `status` ENUM('PENDING', 'ACTIVE', 'SUSPENDED') NOT NULL DEFAULT 'PENDING',
    `description` TEXT NULL,
    `address` VARCHAR(255) NULL,
    `minOrder` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `leadDays` INTEGER NOT NULL DEFAULT 2,
    `portalToken` VARCHAR(64) NULL,
    `portalExpiresAt` DATETIME(3) NULL,
    `lastSeenAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `supplier_accounts_slug_key`(`slug`),
    UNIQUE INDEX `supplier_accounts_email_key`(`email`),
    UNIQUE INDEX `supplier_accounts_portalToken_key`(`portalToken`),
    INDEX `supplier_accounts_country_status_idx`(`country`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `supplier_products` (
    `id` VARCHAR(191) NOT NULL,
    `supplierAccountId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(180) NOT NULL,
    `sku` VARCHAR(60) NULL,
    `barcode` VARCHAR(60) NULL,
    `category` VARCHAR(80) NULL,
    `unitCost` DECIMAL(12, 2) NOT NULL,
    `moq` DECIMAL(12, 3) NOT NULL DEFAULT 1.000,
    `packSize` DECIMAL(12, 3) NOT NULL DEFAULT 1.000,
    `unit` VARCHAR(12) NOT NULL DEFAULT 'pc',
    `inStock` BOOLEAN NOT NULL DEFAULT true,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `supplier_products_supplierAccountId_isActive_idx`(`supplierAccountId`, `isActive`),
    INDEX `supplier_products_barcode_idx`(`barcode`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `supplier_connections` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NOT NULL,
    `supplierAccountId` VARCHAR(191) NOT NULL,
    `status` ENUM('REQUESTED', 'ACTIVE', 'BLOCKED') NOT NULL DEFAULT 'REQUESTED',
    `accountRef` VARCHAR(80) NULL,
    `creditTermDays` INTEGER NOT NULL DEFAULT 0,
    `note` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `supplier_connections_supplierAccountId_status_idx`(`supplierAccountId`, `status`),
    UNIQUE INDEX `supplier_connections_orgId_supplierAccountId_key`(`orgId`, `supplierAccountId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `referrals` (
    `id` VARCHAR(191) NOT NULL,
    `referrerOrgId` VARCHAR(191) NOT NULL,
    `referredOrgId` VARCHAR(191) NOT NULL,
    `code` VARCHAR(16) NOT NULL,
    `creditMonths` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `referrals_referredOrgId_key`(`referredOrgId`),
    INDEX `referrals_referrerOrgId_idx`(`referrerOrgId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `org_sequences` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `orgId` VARCHAR(191) NOT NULL,
    `scope` VARCHAR(20) NOT NULL,
    `current` INTEGER NOT NULL DEFAULT 0,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `org_sequences_orgId_scope_key`(`orgId`, `scope`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_logs` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NULL,
    `actorId` VARCHAR(191) NULL,
    `action` VARCHAR(80) NOT NULL,
    `entity` VARCHAR(60) NOT NULL,
    `entityId` VARCHAR(64) NULL,
    `detail` JSON NULL,
    `ip` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_logs_orgId_createdAt_idx`(`orgId`, `createdAt`),
    INDEX `audit_logs_action_idx`(`action`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `job_runs` (
    `id` VARCHAR(191) NOT NULL,
    `jobName` VARCHAR(60) NOT NULL,
    `runKey` VARCHAR(60) NOT NULL,
    `status` ENUM('RUNNING', 'SUCCEEDED', 'FAILED') NOT NULL DEFAULT 'RUNNING',
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,
    `detail` JSON NULL,
    `error` TEXT NULL,

    INDEX `job_runs_jobName_startedAt_idx`(`jobName`, `startedAt`),
    UNIQUE INDEX `job_runs_jobName_runKey_key`(`jobName`, `runKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `email_messages` (
    `id` VARCHAR(191) NOT NULL,
    `orgId` VARCHAR(191) NULL,
    `dedupeKey` VARCHAR(191) NOT NULL,
    `template` VARCHAR(60) NOT NULL,
    `to` VARCHAR(191) NOT NULL,
    `subject` VARCHAR(255) NOT NULL,
    `html` MEDIUMTEXT NOT NULL,
    `text` TEXT NOT NULL,
    `status` ENUM('PENDING', 'SENT', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `lastError` TEXT NULL,
    `sendAfter` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `sentAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `email_messages_dedupeKey_key`(`dedupeKey`),
    INDEX `email_messages_status_sendAfter_idx`(`status`, `sendAfter`),
    INDEX `email_messages_orgId_createdAt_idx`(`orgId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `organizations` ADD CONSTRAINT `organizations_planCode_fkey` FOREIGN KEY (`planCode`) REFERENCES `Plan`(`code`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `branches` ADD CONSTRAINT `branches_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `branch_stock` ADD CONSTRAINT `branch_stock_branchId_fkey` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `branch_stock` ADD CONSTRAINT `branch_stock_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `org_users` ADD CONSTRAINT `org_users_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `org_users` ADD CONSTRAINT `org_users_branchId_fkey` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `categories` ADD CONSTRAINT `categories_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `products` ADD CONSTRAINT `products_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `products` ADD CONSTRAINT `products_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `categories`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customers` ADD CONSTRAINT `customers_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `registers` ADD CONSTRAINT `registers_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `registers` ADD CONSTRAINT `registers_branchId_fkey` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales` ADD CONSTRAINT `sales_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales` ADD CONSTRAINT `sales_branchId_fkey` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales` ADD CONSTRAINT `sales_shiftId_fkey` FOREIGN KEY (`shiftId`) REFERENCES `shifts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales` ADD CONSTRAINT `sales_registerId_fkey` FOREIGN KEY (`registerId`) REFERENCES `registers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales` ADD CONSTRAINT `sales_cashierId_fkey` FOREIGN KEY (`cashierId`) REFERENCES `org_users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales` ADD CONSTRAINT `sales_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sale_items` ADD CONSTRAINT `sale_items_saleId_fkey` FOREIGN KEY (`saleId`) REFERENCES `sales`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sale_items` ADD CONSTRAINT `sale_items_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_movements` ADD CONSTRAINT `stock_movements_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_movements` ADD CONSTRAINT `stock_movements_branchId_fkey` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `shifts` ADD CONSTRAINT `shifts_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `shifts` ADD CONSTRAINT `shifts_branchId_fkey` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `shifts` ADD CONSTRAINT `shifts_registerId_fkey` FOREIGN KEY (`registerId`) REFERENCES `registers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `loyalty_transactions` ADD CONSTRAINT `loyalty_transactions_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `loyalty_transactions` ADD CONSTRAINT `loyalty_transactions_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `loyalty_transactions` ADD CONSTRAINT `loyalty_transactions_saleId_fkey` FOREIGN KEY (`saleId`) REFERENCES `sales`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `suppliers` ADD CONSTRAINT `suppliers_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_orders` ADD CONSTRAINT `purchase_orders_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_orders` ADD CONSTRAINT `purchase_orders_branchId_fkey` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_orders` ADD CONSTRAINT `purchase_orders_supplierId_fkey` FOREIGN KEY (`supplierId`) REFERENCES `suppliers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_orders` ADD CONSTRAINT `purchase_orders_supplierAccountId_fkey` FOREIGN KEY (`supplierAccountId`) REFERENCES `supplier_accounts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_order_items` ADD CONSTRAINT `purchase_order_items_purchaseOrderId_fkey` FOREIGN KEY (`purchaseOrderId`) REFERENCES `purchase_orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_order_items` ADD CONSTRAINT `purchase_order_items_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `supplier_products` ADD CONSTRAINT `supplier_products_supplierAccountId_fkey` FOREIGN KEY (`supplierAccountId`) REFERENCES `supplier_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `supplier_connections` ADD CONSTRAINT `supplier_connections_supplierAccountId_fkey` FOREIGN KEY (`supplierAccountId`) REFERENCES `supplier_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `referrals` ADD CONSTRAINT `referrals_referrerOrgId_fkey` FOREIGN KEY (`referrerOrgId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `org_sequences` ADD CONSTRAINT `org_sequences_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `email_messages` ADD CONSTRAINT `email_messages_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
