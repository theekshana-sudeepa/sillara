// Standalone script: the app loads .env through src/config/env.ts, but this
// never imports that, so it must load the file itself. Without this line the
// documented `npm run seed` fails on a fresh clone.
import 'dotenv/config';
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();
const D = (n: number) => new Prisma.Decimal(n);

/**
 * Plans are DATA, not code — repricing a tier or adding a feature flag is an
 * UPDATE, not a deploy. paddlePriceId is filled in once the Paddle catalog
 * exists (Paddle dashboard → Catalog → Prices).
 */
async function main(): Promise<void> {
  const plans = [
    {
      code: 'FREE' as const,
      name: 'Free',
      priceUsd: D(0),
      priceLkr: D(0),
      maxTerminals: 1,
      maxProducts: 100,
      maxUsers: 2,
      features: ['sell', 'products', 'daily_report'],
      sortOrder: 0,
    },
    {
      code: 'SHOP' as const,
      name: 'Shop',
      priceUsd: D(19),
      priceLkr: D(2900),
      maxTerminals: 2,
      maxProducts: -1,
      maxUsers: 5,
      features: ['sell', 'products', 'daily_report', 'inventory', 'customers', 'whatsapp_receipts'],
      sortOrder: 1,
    },
    {
      code: 'PRO' as const,
      name: 'Pro',
      priceUsd: D(49),
      priceLkr: D(6900),
      maxTerminals: 10,
      maxProducts: -1,
      maxUsers: 25,
      features: ['sell', 'products', 'daily_report', 'inventory', 'customers', 'whatsapp_receipts', 'loyalty', 'multi_branch', 'shifts', 'purchase_orders'],
      sortOrder: 2,
    },
  ];

  for (const plan of plans) {
    await prisma.plan.upsert({ where: { code: plan.code }, update: plan, create: plan });
  }
  console.log('✅ plans seeded: FREE / SHOP ($19 · LKR 2,900) / PRO ($49 · LKR 6,900)');

  // --- demo supplier so the network isn't an empty room on day one --------
  // A directory with nothing in it teaches a shop owner that the feature is
  // dead. One real-looking supplier makes the first visit make sense.
  if (process.env.SEED_DEMO !== 'true') return;

  const supplier = await prisma.supplierAccount.upsert({
    where: { email: 'orders@ceylondistributors.lk' },
    update: {},
    create: {
      slug: 'ceylon-distributors',
      name: 'Ceylon Distributors (Pvt) Ltd',
      email: 'orders@ceylondistributors.lk',
      phone: '+94 11 234 5678',
      country: 'LK',
      currency: 'LKR',
      status: 'ACTIVE',
      description: 'FMCG, dry goods and beverages across the Western Province',
      minOrder: D(10000),
      leadDays: 2,
    },
  });

  const catalog = [
    { name: 'Rice 5kg (Nadu)', unitCost: 1150, moq: 5, unit: 'pc', category: 'Dry goods' },
    { name: 'Sugar 1kg', unitCost: 245, moq: 10, unit: 'pc', category: 'Dry goods' },
    { name: 'Anchor Milk Powder 400g', unitCost: 980, moq: 6, unit: 'pc', category: 'Dairy' },
    { name: 'Water Bottle 500ml', unitCost: 45, moq: 24, unit: 'pc', category: 'Drinks' },
    { name: 'Soft Drink 400ml', unitCost: 85, moq: 24, unit: 'pc', category: 'Drinks' },
    { name: 'Biscuits (assorted)', unitCost: 62, moq: 20, unit: 'pc', category: 'Snacks' },
    { name: 'Chips 50g', unitCost: 95, moq: 20, unit: 'pc', category: 'Snacks' },
    { name: 'Soap Bar', unitCost: 130, moq: 12, unit: 'pc', category: 'Household' },
  ];

  for (const item of catalog) {
    const exists = await prisma.supplierProduct.findFirst({
      where: { supplierAccountId: supplier.id, name: item.name },
    });
    if (exists) continue;
    await prisma.supplierProduct.create({
      data: {
        supplierAccountId: supplier.id,
        name: item.name,
        category: item.category,
        unitCost: D(item.unitCost),
        moq: D(item.moq),
        unit: item.unit,
      },
    });
  }

  console.log('✅ demo supplier seeded: Ceylon Distributors (8 catalog items)');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
