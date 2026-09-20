import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '@/app/providers/I18nProvider';
import { ThemeProvider } from '@/app/providers/ThemeProvider';
import { ToastProvider } from '@/app/providers/ToastProvider';

/**
 * Screen smoke tests for the redesign.
 *
 * A route returning 200 only proves the dev server answered — the SPA shell is
 * the same HTML for every path. These mount the real page components against a
 * stubbed API and assert that the figures a shopkeeper would act on actually
 * reach the screen.
 *
 * They also guard the specific thing a visual redesign breaks: a page that
 * renders but silently shows a translation key, or an empty state where data
 * was supposed to be.
 */

/* --------------------------------------------------------------- Fixtures */

const PULSE = {
  pulse: {
    generatedAt: new Date().toISOString(),
    engine: 'deterministic' as const,
    cards: [
      {
        id: 'c1',
        kind: 'payments' as const,
        severity: 'warning' as const,
        title: '13 customers owe you money',
        body: 'Oldest is 12 days overdue.',
        narration: 'Oldest is 12 days overdue.',
        metrics: {},
        actionLabel: 'Review',
        actionHref: '/app/payments',
        priority: 90,
      },
    ],
  },
  today: {
    revenue: 337_900,
    estimatedProfit: 48_200,
    saleCount: 11,
    customerCount: 11,
    pending: 1_724_100,
    totalCustomers: 36,
  },
};

const SUMMARY = {
  days: 7,
  revenue: 1_500_000,
  saleCount: 48,
  series: [
    { date: '2026-09-13', revenue: 210_000, saleCount: 7 },
    { date: '2026-09-14', revenue: 180_000, saleCount: 6 },
    { date: '2026-09-15', revenue: 0, saleCount: 0 },
    { date: '2026-09-16', revenue: 240_000, saleCount: 8 },
    { date: '2026-09-17', revenue: 260_000, saleCount: 9 },
    { date: '2026-09-18', revenue: 272_100, saleCount: 7 },
    { date: '2026-09-19', revenue: 337_900, saleCount: 11 },
  ],
};

const TRANSACTIONS = {
  transactions: [
    {
      transactionId: 't1',
      vendorId: 'v1',
      customerId: 'c1',
      customerName: 'Ramesh Kumar',
      items: [{ name: 'Rice', quantity: 2, unit: 'kg', unitPrice: 6200, lineTotal: 12400 }],
      subtotal: 12_400,
      discount: 0,
      total: 12_400,
      paid: 12_400,
      outstanding: 0,
      paymentMethod: 'cash',
      source: 'manual',
      timestamp: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
  totals: { count: 1, revenue: 12_400, pending: 0, collected: 12_400 },
};

const CUSTOMERS = {
  customers: [
    {
      customerId: 'c1',
      vendorId: 'v1',
      name: 'Priya Singh',
      phone: '9810012345',
      email: '',
      qrId: 'q1',
      outstanding: 120_000,
      totalSpent: 482_000,
      transactionCount: 12,
      notes: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastInteractionAt: new Date().toISOString(),
      overdueAmount: 73_300,
      overdueCount: 2,
    },
  ],
  totals: { count: 36, outstanding: 1_724_100, overdue: 733_000, overdueCount: 13 },
};

const INVENTORY = {
  products: [
    {
      productId: 'p1',
      vendorId: 'v1',
      name: 'Fortune Sunflower Oil',
      sku: 'OIL',
      category: 'staples',
      unit: 'unit',
      costPrice: 12_800,
      sellingPrice: 14_500,
      stock: 8,
      reorderLevel: 20,
      supplier: 'FreshMart Suppliers',
      purchaseDate: '2026-09-07',
      salesVelocity: 2,
      aliases: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // Both derived on the server; the screen renders what it is sent.
      stockValue: 102_400,
      stockStatus: 'low_stock',
      insight: {
        soldThisWeek: 14,
        salesVelocity: 2,
        daysRemaining: 4,
        lowStock: true,
        outOfStock: false,
        belowReorderLevel: true,
        marginPercent: 12,
        suggestedRestockQuantity: 20,
      },
    },
  ],
  totals: {
    count: 142,
    inStockCount: 134,
    lowStockCount: 8,
    outOfStockCount: 0,
    runningOutCount: 11,
    stockValue: 4_500_000,
  },
  thresholds: { lowStockDays: 7 },
};

const ORDERS = {
  orders: [
    {
      orderId: 'o1',
      vendorId: 'v1',
      customerId: 'c1',
      customerName: 'Priya Singh',
      items: [{ name: 'Atta', quantity: 3, unit: 'kg', unitPrice: 4800, lineTotal: 14400 }],
      total: 84_000,
      status: 'ready',
      notes: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
  totals: { count: 4, readyCount: 4, value: 84_000 },
};

/* ------------------------------------------------------------------ Mocks */

const routes: Record<string, unknown> = {};

vi.mock('@/hooks/useApi', () => ({
  useQuery: (path: string | null) => ({
    data: path ? (routes[path] ?? null) : null,
    loading: false,
    error: null,
    refetch: vi.fn(),
    setData: vi.fn(),
  }),
}));

vi.mock('@/app/providers/AuthProvider', () => ({
  useAuth: () => ({
    status: 'authenticated',
    user: { userId: 'u1', name: 'Anil', email: 'a@b.c', role: 'SHOPKEEPER' },
    vendor: { vendorId: 'v1', shopName: 'Sharma Stores', city: 'Patna' },
    needsOnboarding: false,
    demoLogin: vi.fn(),
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/app/providers/OfflineProvider', () => ({
  useOffline: () => ({ online: true, enqueue: vi.fn(), queue: [], syncing: false }),
}));

beforeEach(() => {
  routes['/ai/pulse'] = PULSE;
  routes['/transactions/summary'] = SUMMARY;
  routes['/transactions'] = TRANSACTIONS;
  routes['/customers'] = CUSTOMERS;
  routes['/inventory'] = INVENTORY;
  routes['/orders'] = ORDERS;
});

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

/* ------------------------------------------------------------------ Tests */

describe('dashboard', () => {
  it('leads with today takings and the shop name', async () => {
    const { default: HomePage } = await import('@/features/dashboard/HomePage');
    mount(<HomePage />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Sharma Stores');
    // ₹3,379 — the one figure the screen exists for.
    expect(await screen.findByText(/3,379/)).toBeInTheDocument();
  });

  it('shows what needs attention as an actionable row', async () => {
    const { default: HomePage } = await import('@/features/dashboard/HomePage');
    mount(<HomePage />);

    expect(screen.getByText('13 customers owe you money')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review' })).toHaveAttribute('href', '/app/payments');
  });

  it('offers the quick actions, with scanning first', async () => {
    const { default: HomePage } = await import('@/features/dashboard/HomePage');
    mount(<HomePage />);

    for (const label of ['Scan customer', 'Add sale', 'New order', 'Speak']) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
  });

  it('draws a week of takings, including the day with none', async () => {
    const { default: HomePage } = await import('@/features/dashboard/HomePage');
    mount(<HomePage />);

    // Seven bars: a zero day is a fact about the week, not a gap.
    const bars = screen.getAllByRole('button', { name: /^[A-Za-z]{3}: ₹/ });
    expect(bars).toHaveLength(7);
    expect(bars.some((bar) => /: ₹0$/.test(bar.getAttribute('aria-label') ?? ''))).toBe(true);
  });

  it('lists recent activity with a real customer', async () => {
    const { default: HomePage } = await import('@/features/dashboard/HomePage');
    mount(<HomePage />);
    expect(screen.getByText('Ramesh Kumar')).toBeInTheDocument();
  });
});

describe('customers', () => {
  it('shows the count and outstanding in the header, not as cards', async () => {
    const { default: CustomersPage } = await import('@/features/customers/CustomersPage');
    mount(<CustomersPage />);

    const header = screen.getByRole('banner');
    expect(within(header).getByText('36')).toBeInTheDocument();
    expect(within(header).getByText(/17\.2k|17,241/i)).toBeInTheDocument();
  });

  it('renders a scannable row per customer', async () => {
    const { default: CustomersPage } = await import('@/features/customers/CustomersPage');
    mount(<CustomersPage />);

    expect(screen.getAllByText('Priya Singh').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/1,200/).length).toBeGreaterThan(0);
  });
});

  /**
   * A balance that is merely unpaid and one that is weeks late are different
   * problems. The list must say which is which, and it must not rest that
   * distinction on colour alone.
   */
  it('marks an overdue customer distinctly from one who simply owes', async () => {
    const { default: CustomersPage } = await import('@/features/customers/CustomersPage');
    mount(<CustomersPage />);

    // The word, not just the red — this is the part a colour-blind
    // shopkeeper has to be able to read.
    expect(screen.getAllByText(/overdue/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/733/).length).toBeGreaterThan(0);
  });

describe('inventory', () => {
  it('lifts low stock into its own band', async () => {
    const { default: InventoryPage } = await import('@/features/inventory/InventoryPage');
    mount(<InventoryPage />);

    expect(screen.getAllByText('Fortune Sunflower Oil').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/LOW STOCK|d LEFT/).length).toBeGreaterThan(0);
  });
});

describe('orders', () => {
  it('shows status and the action that advances it', async () => {
    const { default: OrdersPage } = await import('@/features/orders/OrdersPage');
    mount(<OrdersPage />);

    expect(screen.getByText('Priya Singh')).toBeInTheDocument();
    // The copy reads "Tell customer" — assert the control, not the wording.
    expect(screen.getByRole('button', { name: /tell customer|notify/i })).toBeInTheDocument();
  });
});

describe('sales', () => {
  it('summarises revenue, collected and outstanding', async () => {
    const { default: SalesPage } = await import('@/features/transactions/SalesPage');
    mount(<SalesPage />);

    expect(screen.getByText('Revenue')).toBeInTheDocument();
    expect(screen.getByText('Outstanding')).toBeInTheDocument();
  });
});

describe('translation keys', () => {
  /**
   * A missing key falls back to its last path segment, so the screen still
   * renders — it just says "addSale" to the shopkeeper. This catches that.
   */
  it('no screen renders a raw camelCase key', async () => {
    const pages = await Promise.all([
      import('@/features/dashboard/HomePage'),
      import('@/features/customers/CustomersPage'),
      import('@/features/inventory/InventoryPage'),
      import('@/features/orders/OrdersPage'),
      import('@/features/transactions/SalesPage'),
    ]);

    for (const page of pages) {
      const { container, unmount } = mount(<page.default />);

      // Per text node, never the concatenation: `textContent` welds adjacent
      // elements together, so "est. profit" followed by "Pending" would read
      // as the camelCase "profitPending" and fail a page that is correct.
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      const leaked: string[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const value = (node.nodeValue ?? '').trim();
        // A node that is exactly one camelCase identifier is an untranslated
        // key. Real copy carries a space or punctuation somewhere.
        if (/^[a-z]+(?:[A-Z][a-z]*)+$/.test(value)) leaked.push(value);
      }

      expect(leaked).toEqual([]);
      unmount();
    }
  });
});
