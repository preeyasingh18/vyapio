import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '@/app/providers/I18nProvider';
import { ThemeProvider } from '@/app/providers/ThemeProvider';
import { ToastProvider } from '@/app/providers/ToastProvider';

/**
 * The stock screen's own behaviour: search, filtering, sorting and the status
 * badge.
 *
 * These live apart from the screen smoke tests because they assert on
 * interaction rather than on first paint. The status badge in particular is
 * worth pinning here as well as on the server: it is the one thing on the
 * screen a shopkeeper acts on without reading the numbers beside it.
 */

/* --------------------------------------------------------------- Fixture */

type Row = {
  name: string;
  supplier: string;
  unit: string;
  costPrice: number;
  stock: number;
  reorderLevel: number;
  purchaseDate: string;
};

const CATALOGUE: Row[] = [
  { name: 'Rice', supplier: 'Shree Traders', unit: 'kg', costPrice: 6000, stock: 50, reorderLevel: 10, purchaseDate: '2026-09-10' },
  { name: 'Cooking Oil', supplier: 'FreshMart Suppliers', unit: 'litre', costPrice: 14_000, stock: 5, reorderLevel: 5, purchaseDate: '2026-09-07' },
  { name: 'Coffee', supplier: 'Bean House Suppliers', unit: 'kg', costPrice: 45_000, stock: 0, reorderLevel: 3, purchaseDate: '2026-09-04' },
  { name: 'Biscuits', supplier: 'Gupta Wholesale', unit: 'packet', costPrice: 3000, stock: 100, reorderLevel: 20, purchaseDate: '2026-09-12' },
];

/** Mirrors the server: quantity against reorder level, nothing stored. */
function statusFor(row: Row): string {
  if (row.stock <= 0) return 'out_of_stock';
  if (row.stock <= row.reorderLevel) return 'low_stock';
  return 'in_stock';
}

const INVENTORY = {
  products: CATALOGUE.map((row, index) => ({
    productId: `p${index}`,
    vendorId: 'v1',
    sku: '',
    category: 'staples',
    sellingPrice: Math.round(row.costPrice * 1.25),
    salesVelocity: 0,
    aliases: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...row,
    stockValue: Math.max(0, row.stock) * row.costPrice,
    stockStatus: statusFor(row),
    insight: {
      soldThisWeek: 0,
      salesVelocity: 0,
      daysRemaining: null,
      lowStock: statusFor(row) !== 'in_stock',
      outOfStock: row.stock <= 0,
      belowReorderLevel: row.stock <= row.reorderLevel,
      marginPercent: 20,
      suggestedRestockQuantity: 0,
    },
  })),
  totals: {
    count: 4,
    inStockCount: 2,
    lowStockCount: 1,
    outOfStockCount: 1,
    runningOutCount: 2,
    stockValue: CATALOGUE.reduce((sum, row) => sum + Math.max(0, row.stock) * row.costPrice, 0),
  },
  thresholds: { lowStockDays: 3 },
};

/* ----------------------------------------------------------------- Stubs */

vi.mock('@/hooks/useApi', () => ({
  useQuery: () => ({ data: INVENTORY, loading: false, error: null, refetch: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), loading: false, error: null }),
}));

vi.mock('@/app/providers/AuthProvider', () => ({
  useAuth: () => ({
    status: 'authenticated',
    user: { userId: 'u1', name: 'Anil', email: 'a@b.c', role: 'SHOPKEEPER' },
    vendor: { vendorId: 'v1', shopName: 'Sharma Stores', city: 'Patna' },
    needsOnboarding: false,
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/app/providers/OfflineProvider', () => ({
  useOffline: () => ({ online: true, enqueue: vi.fn(), queue: [], syncing: false }),
}));

function mount(ui: React.ReactElement) {
  return render(
    <I18nProvider>
      <ThemeProvider>
        <ToastProvider>
          <MemoryRouter>{ui}</MemoryRouter>
        </ToastProvider>
      </ThemeProvider>
    </I18nProvider>,
  );
}

async function mountPage() {
  const { default: InventoryPage } = await import('@/features/inventory/InventoryPage');
  return mount(<InventoryPage />);
}

/** The desktop table; the same rows also render as cards for narrow screens. */
function table(): HTMLElement {
  const found = document.querySelector('table');
  if (!found) throw new Error('no table rendered');
  return found as HTMLElement;
}

function itemNames(): string[] {
  const body = table().querySelector('tbody');
  return Array.from(body?.querySelectorAll('tr') ?? []).map(
    // The first cell also carries a supplier line for narrow screens, which
    // jsdom renders regardless of the breakpoint class. The name is the first
    // paragraph in it.
    (row) => row.querySelector('td p')?.textContent?.trim() ?? '',
  );
}

/* ----------------------------------------------------------------- Tests */

beforeEach(() => {
  vi.clearAllMocks();
});

describe('stock summary', () => {
  it('shows item count, value and what needs attention', async () => {
    await mountPage();

    expect(screen.getByText('Total items')).toBeInTheDocument();
    expect(screen.getByText('Total stock value')).toBeInTheDocument();
    // 50x60 + 5x140 + 0 + 100x30 = 3000 + 700 + 0 + 3000 = Rs6,700
    expect(screen.getAllByText(/6,700|6.7K/i).length).toBeGreaterThan(0);
  });
});

describe('status badges', () => {
  it('derives each row from quantity against its reorder level', async () => {
    await mountPage();
    const rows = within(table()).getAllByRole('row').slice(1);

    const statusOfRow = (name: string) => {
      const row = rows.find((candidate) => candidate.textContent?.includes(name));
      return row?.textContent ?? '';
    };

    // 50 above a level of 10.
    expect(statusOfRow('Rice')).toContain('IN STOCK');
    // 5 exactly at a level of 5 — at the level is already time to buy.
    expect(statusOfRow('Cooking Oil')).toContain('LOW STOCK');
    // Nothing left.
    expect(statusOfRow('Coffee')).toContain('OUT OF STOCK');
  });

  it('shows each item with its supplier and stock value', async () => {
    await mountPage();
    const body = table().textContent ?? '';

    expect(body).toContain('Shree Traders');
    expect(body).toContain('Bean House Suppliers');
    // Rice: 50 x Rs60
    expect(body).toContain('₹3,000');
    // Purchase dates are shown as days, not raw ISO strings.
    expect(body).toMatch(/10 Sept? 2026/);
  });
});

describe('search', () => {
  it('matches on item name', async () => {
    await mountPage();
    fireEvent.change(screen.getByPlaceholderText(/search item or supplier/i), {
      target: { value: 'rice' },
    });

    expect(itemNames()).toEqual(['Rice']);
  });

  it('matches on supplier too, because that is how restocking is planned', async () => {
    await mountPage();
    fireEvent.change(screen.getByPlaceholderText(/search item or supplier/i), {
      target: { value: 'gupta' },
    });

    expect(itemNames()).toEqual(['Biscuits']);
  });

  it('says so when nothing matches', async () => {
    await mountPage();
    fireEvent.change(screen.getByPlaceholderText(/search item or supplier/i), {
      target: { value: 'zzzz' },
    });

    expect(screen.getByText(/no products match/i)).toBeInTheDocument();
  });
});

describe('filters', () => {
  it('narrows to each stock status', async () => {
    await mountPage();

    fireEvent.click(screen.getByRole('tab', { name: /^In stock/ }));
    expect(itemNames().sort()).toEqual(['Biscuits', 'Rice']);

    fireEvent.click(screen.getByRole('tab', { name: /^Low stock/ }));
    expect(itemNames()).toEqual(['Cooking Oil']);

    fireEvent.click(screen.getByRole('tab', { name: /^Out of stock/ }));
    expect(itemNames()).toEqual(['Coffee']);

    fireEvent.click(screen.getByRole('tab', { name: /^All/ }));
    expect(itemNames()).toHaveLength(4);
  });
});

describe('sorting', () => {
  const sortBy = (label: string) => {
    fireEvent.change(screen.getByLabelText(/sort by/i), { target: { value: label } });
  };

  it('orders by name, price, quantity, value and purchase date', async () => {
    await mountPage();

    sortBy('name');
    expect(itemNames()).toEqual(['Biscuits', 'Coffee', 'Cooking Oil', 'Rice']);

    // Biscuits 30, Rice 60, Oil 140, Coffee 450
    sortBy('price');
    expect(itemNames()).toEqual(['Biscuits', 'Rice', 'Cooking Oil', 'Coffee']);

    // Coffee 0, Oil 5, Rice 50, Biscuits 100
    sortBy('quantity');
    expect(itemNames()).toEqual(['Coffee', 'Cooking Oil', 'Rice', 'Biscuits']);

    // Coffee 0, Oil 700, then Rice and Biscuits both 3000
    sortBy('value');
    expect(itemNames().slice(0, 2)).toEqual(['Coffee', 'Cooking Oil']);

    // Sep 4, 7, 10, 12
    sortBy('purchaseDate');
    expect(itemNames()).toEqual(['Coffee', 'Cooking Oil', 'Rice', 'Biscuits']);
  });

  it('reverses on demand', async () => {
    await mountPage();

    fireEvent.change(screen.getByLabelText(/sort by/i), { target: { value: 'name' } });
    expect(itemNames()).toEqual(['Biscuits', 'Coffee', 'Cooking Oil', 'Rice']);

    fireEvent.click(screen.getByRole('button', { name: /sort descending|sort ascending/i }));
    expect(itemNames()).toEqual(['Rice', 'Cooking Oil', 'Coffee', 'Biscuits']);
  });
});

describe('actions', () => {
  it('offers restock, edit and delete on every row', async () => {
    await mountPage();

    // Four rows in the table plus four narrow-screen cards.
    expect(screen.getAllByRole('button', { name: /^Restock$/ }).length).toBeGreaterThanOrEqual(4);
    expect(screen.getAllByRole('button', { name: /^Edit$/ }).length).toBeGreaterThanOrEqual(4);
    expect(screen.getAllByRole('button', { name: /^Delete$/ }).length).toBeGreaterThanOrEqual(4);
  });

  it('opens restock with the current quantity in view', async () => {
    await mountPage();

    fireEvent.click(screen.getAllByRole('button', { name: /^Restock$/ })[0]!);

    expect(screen.getByText(/current quantity/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/quantity to add/i)).toBeInTheDocument();
  });
});
