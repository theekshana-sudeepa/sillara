-- Per-line cost and tax snapshots.
--
-- Additive and nullable: an older API instance still writing rows without
-- these columns keeps working through the deploy.

-- AlterTable
ALTER TABLE `sale_items` ADD COLUMN `netExTax` DECIMAL(12, 2) NULL,
    ADD COLUMN `taxAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN `unitCost` DECIMAL(12, 2) NULL;

-- Backfill revenue and tax for sales that already exist, by splitting each
-- sale's recorded tax and discounts across its lines in proportion to what
-- each line contributed. This is the same allocation the application now does
-- at sale time, minus the largest-remainder correction — historical rows can
-- be a cent out against their parent sale, which is accepted here because the
-- alternative is leaving every past sale invisible to margin reporting.
UPDATE `sale_items` si
JOIN `sales` s ON s.id = si.saleId
JOIN (
  SELECT saleId, SUM(lineTotal) AS gross
  FROM `sale_items`
  GROUP BY saleId
) g ON g.saleId = si.saleId
SET
  si.taxAmount = ROUND(s.tax * (si.lineTotal / g.gross), 2),
  si.netExTax  = ROUND(
                   si.lineTotal
                   - ((s.discount + s.loyaltyDiscount) * (si.lineTotal / g.gross))
                   - (s.tax * (si.lineTotal / g.gross)),
                 2)
WHERE si.netExTax IS NULL
  AND g.gross > 0;

-- `unitCost` is deliberately left NULL for historical lines.
--
-- The only cost available for a past sale is `products.cost`, which is the
-- current cost — the very number whose overwriting made historical margin
-- untrustworthy in the first place. Backfilling from it would launder a guess
-- into the ledger and make it permanent. Reports count these lines as
-- uncosted and say so, which is the honest answer to "what did that cost?"
-- when the record was never kept.
