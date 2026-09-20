/**
 * Seeds a shop's stock catalogue.
 *
 *   npm run seed:inventory              into the demo shop (Sharma Stores)
 *   npm run seed:inventory -- --vendor ven_xxx   into a specific shop
 *   npm run seed:inventory -- --replace          overwrite prices/quantities too
 *
 * Idempotent by product name within the shop. Re-running does not duplicate
 * rows: an item that already exists is filled in where it is blank (supplier,
 * reorder level, purchase date) and otherwise left alone, because by then the
 * quantity on the shelf is the shop's, not the seeder's. `--replace` overrides
 * that and resets every listed field, which is what you want on a fresh demo.
 *
 * Money is written in paise, quantities as plain numbers — the same contract as
 * the rest of the system, so these rows behave identically to hand-entered ones
 * through sales, restocks and valuation.
 */

import { config } from '../src/config/index';
import { authService } from '../src/services/auth';
import { getStore, setStore } from '../src/services/dynamodb';
import { LocalStore } from '../src/services/localStore';
import {
  inventoryEventItem,
  products as productRepo,
  vendors as vendorRepo,
} from '../src/services/repository';
import { stockStatusOf, stockValueOf } from '../src/services/inventory';
import { formatMoney, rupeesToPaise } from '../src/utils/money';
import { nowIso } from '../src/utils/dates';
import { newInventoryEventId, newProductId } from '../src/utils/ids';
import { ProductSchema, type InventoryEvent, type Product } from '../src/schemas/entities';

type StockSeed = {
  name: string;
  unit: string;
  /** Rupees, converted to paise on write. */
  unitPrice: number;
  quantity: number;
  supplier: string;
  reorderLevel: number;
  /** YYYY-MM-DD. */
  purchaseDate: string;
  category: string;
  aliases: string[];
  /** Retail price in rupees. Margin only; stock is always valued at cost. */
  sellingPrice: number;
};

const CATALOGUE: StockSeed[] = [
  { name: 'Rice',         unit: 'kg',     unitPrice: 60,  quantity: 50,  supplier: 'Shree Traders',        reorderLevel: 10, purchaseDate: '2026-09-10', category: 'staples',   aliases: ['chawal', 'basmati'], sellingPrice: 75 },
  { name: 'Wheat Flour',  unit: 'kg',     unitPrice: 45,  quantity: 40,  supplier: 'Gupta Wholesale',      reorderLevel: 10, purchaseDate: '2026-09-09', category: 'staples',   aliases: ['atta', 'aata', 'gehu'], sellingPrice: 56 },
  { name: 'Sugar',        unit: 'kg',     unitPrice: 50,  quantity: 35,  supplier: 'Shree Traders',        reorderLevel: 10, purchaseDate: '2026-09-08', category: 'staples',   aliases: ['cheeni', 'chini'], sellingPrice: 62 },
  { name: 'Cooking Oil',  unit: 'litre',  unitPrice: 140, quantity: 25,  supplier: 'FreshMart Suppliers',  reorderLevel: 5,  purchaseDate: '2026-09-07', category: 'staples',   aliases: ['tel', 'refined oil'], sellingPrice: 168 },
  { name: 'Milk',         unit: 'litre',  unitPrice: 60,  quantity: 30,  supplier: 'Daily Dairy Co.',      reorderLevel: 8,  purchaseDate: '2026-09-18', category: 'dairy',     aliases: ['doodh', 'dudh'], sellingPrice: 72 },
  { name: 'Tea',          unit: 'kg',     unitPrice: 280, quantity: 15,  supplier: 'Assam Tea Suppliers',  reorderLevel: 5,  purchaseDate: '2026-09-05', category: 'pantry',    aliases: ['chai', 'chai patti'], sellingPrice: 340 },
  { name: 'Coffee',       unit: 'kg',     unitPrice: 450, quantity: 10,  supplier: 'Bean House Suppliers', reorderLevel: 3,  purchaseDate: '2026-09-04', category: 'pantry',    aliases: ['kaapi'], sellingPrice: 540 },
  { name: 'Biscuits',     unit: 'packet', unitPrice: 30,  quantity: 100, supplier: 'Gupta Wholesale',      reorderLevel: 20, purchaseDate: '2026-09-12', category: 'pantry',    aliases: ['biscuit', 'parle'], sellingPrice: 38 },
  { name: 'Salt',         unit: 'kg',     unitPrice: 25,  quantity: 40,  supplier: 'Shree Traders',        reorderLevel: 10, purchaseDate: '2026-09-06', category: 'staples',   aliases: ['namak'], sellingPrice: 31 },
  { name: 'Dal',          unit: 'kg',     unitPrice: 120, quantity: 30,  supplier: 'FreshMart Suppliers',  reorderLevel: 8,  purchaseDate: '2026-09-11', category: 'staples',   aliases: ['daal', 'toor', 'arhar'], sellingPrice: 145 },
];

export type SeedInventoryResult = {
  vendorId: string;
  created: number;
  updated: number;
  unchanged: number;
};

/** Case- and space-insensitive, so "Wheat  flour" is not a second product. */
function normalise(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export async function seedInventory(options: {
  vendorId: string;
  replace?: boolean;
}): Promise<SeedInventoryResult> {
  const { vendorId, replace = false } = options;

  const existing = await productRepo.list(vendorId);
  const byName = new Map(existing.map((product) => [normalise(product.name), product]));

  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const seed of CATALOGUE) {
    const current = byName.get(normalise(seed.name));

    if (!current) {
      const product: Product = ProductSchema.parse({
        productId: newProductId(),
        vendorId,
        name: seed.name,
        sku: seed.name.toUpperCase().replace(/\s+/g, '-').slice(0, 12),
        category: seed.category,
        unit: seed.unit,
        costPrice: rupeesToPaise(seed.unitPrice),
        sellingPrice: rupeesToPaise(seed.sellingPrice),
        stock: seed.quantity,
        reorderLevel: seed.reorderLevel,
        supplier: seed.supplier,
        purchaseDate: seed.purchaseDate,
        salesVelocity: 0,
        aliases: seed.aliases,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      } satisfies Product);

      await productRepo.put(product);

      // Opening stock is an event, same as every other unit that moves, so the
      // ledger still explains the quantity on the shelf.
      const event: InventoryEvent = {
        inventoryEventId: newInventoryEventId(),
        vendorId,
        productId: product.productId,
        productName: product.name,
        type: 'stock_in',
        quantityDelta: seed.quantity,
        stockAfter: seed.quantity,
        unitPrice: product.costPrice,
        note: `Opening stock from ${seed.supplier}`,
        timestamp: `${seed.purchaseDate}T09:00:00.000Z`,
        source: 'manual',
      };
      await getStore().put(inventoryEventItem(event));

      created += 1;
      continue;
    }

    // Already there. Fill the gaps; leave the shop's own numbers alone unless
    // asked to replace them.
    const changes: Partial<Product> = {};
    if (replace) {
      Object.assign(changes, {
        unit: seed.unit,
        costPrice: rupeesToPaise(seed.unitPrice),
        sellingPrice: rupeesToPaise(seed.sellingPrice),
        stock: seed.quantity,
        reorderLevel: seed.reorderLevel,
        supplier: seed.supplier,
        purchaseDate: seed.purchaseDate,
      });
    } else {
      if (!current.supplier) changes.supplier = seed.supplier;
      if (!current.purchaseDate) changes.purchaseDate = seed.purchaseDate;
      if (!current.reorderLevel) changes.reorderLevel = seed.reorderLevel;
    }

    if (Object.keys(changes).length === 0) {
      unchanged += 1;
      continue;
    }

    await productRepo.update(vendorId, current.productId, changes);
    updated += 1;
  }

  return { vendorId, created, updated, unchanged };
}

/* --------------------------------------------------------------------- CLI */

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const replace = process.argv.includes('--replace');
  let vendorId = argValue('--vendor');

  if (config.database.mode === 'local') {
    setStore(new LocalStore(config.database.localDir));
    console.log(`\n  Store: local file (${config.database.localDir}/table.json)`);
  } else {
    console.log(`\n  Store: DynamoDB table "${config.database.tableName}" in ${config.region}`);
  }

  if (!vendorId) {
    // No shop named: resolve the demo shop the way the app does — sign in, then
    // look up the vendor behind that session. There is no scan API and there
    // should not be one; tenancy is always resolved from an identity.
    const tokens = await authService
      .login(config.demo.email, config.demo.password)
      .catch(() => {
        throw new Error(
          `Could not sign in as ${config.demo.email}. Create the demo shop first:\n` +
            '    npm run seed -- --reset --empty\n' +
            '  or target an existing shop with --vendor ven_xxx',
        );
      });
    const session = await authService.verify(tokens.accessToken);
    const demo = await vendorRepo.findByUserId(session.userId);
    if (!demo) {
      throw new Error(
        `${config.demo.email} has no shop yet. Create one with:\n` +
          '    npm run seed -- --reset --empty',
      );
    }
    vendorId = demo.vendorId;
    console.log(`  Shop: ${demo.shopName} (${vendorId})`);
  } else {
    const vendor = await vendorRepo.get(vendorId);
    if (!vendor) throw new Error(`No shop with id ${vendorId}`);
    console.log(`  Shop: ${vendor.shopName} (${vendorId})`);
  }

  const result = await seedInventory({ vendorId, replace });

  console.log(
    `\n  ${result.created} created, ${result.updated} updated, ${result.unchanged} already current\n`,
  );

  const products = await productRepo.list(vendorId);
  const listed = new Set(CATALOGUE.map((seed) => normalise(seed.name)));
  const rows = products.filter((product) => listed.has(normalise(product.name)));

  const LABEL: Record<string, string> = {
    in_stock: 'IN STOCK',
    low_stock: 'LOW STOCK',
    out_of_stock: 'OUT OF STOCK',
  };

  console.log(
    `  ${'ITEM'.padEnd(14)}${'SUPPLIER'.padEnd(23)}${'PRICE'.padStart(9)}` +
      `${'QTY'.padStart(13)}${'REORDER'.padStart(9)}${'VALUE'.padStart(11)}` +
      `  ${'PURCHASED'.padEnd(12)}STATUS`,
  );
  for (const product of rows) {
    console.log(
      `  ${product.name.padEnd(14)}${product.supplier.padEnd(23)}` +
        `${formatMoney(product.costPrice).padStart(9)}` +
        `${`${product.stock} ${product.unit}`.padStart(13)}` +
        `${String(product.reorderLevel).padStart(9)}` +
        `${formatMoney(stockValueOf(product)).padStart(11)}` +
        `  ${(product.purchaseDate || '-').padEnd(12)}` +
        `${LABEL[stockStatusOf(product)]}`,
    );
  }

  const total = rows.reduce((sum, product) => sum + stockValueOf(product), 0);
  console.log(`\n  ${rows.length} items, total stock value ${formatMoney(total)}\n`);
}

const invokedDirectly = process.argv[1]?.includes('seed-inventory');
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error('\n  Seeding inventory failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
