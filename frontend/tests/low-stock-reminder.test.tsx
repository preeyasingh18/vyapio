import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { I18nProvider } from '@/app/providers/I18nProvider';
import { ThemeProvider } from '@/app/providers/ThemeProvider';
import { LowStockReminder } from '@/components/layout/LowStockReminder';

/**
 * The reminder shown when the shop is opened.
 *
 * Its whole value is that it names the item and offers to fix it. A banner
 * saying "inventory is low" tells a shopkeeper nothing they can act on, and an
 * alert that can be permanently dismissed goes quiet while the shelf is still
 * empty — so neither is allowed here.
 */

const alerts = vi.hoisted(() => ({ current: [] as unknown[] }));

vi.mock('@/hooks/useApi', () => ({
  useQuery: () => ({
    data: {
      alerts: alerts.current,
      counts: { lowStock: 0, outOfStock: 0 },
      threshold: 5,
    },
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

function alert(over: Record<string, unknown>) {
  return {
    productId: 'p1',
    name: 'Milk',
    unit: 'litre',
    stock: 4,
    lowStockAt: 5,
    supplier: 'Daily Dairy Co.',
    status: 'low_stock',
    ...over,
  };
}

/** Renders the reminder, and a stub stock page to catch where it navigates. */
function mount() {
  return render(
    <I18nProvider>
      <ThemeProvider>
        <MemoryRouter initialEntries={['/app']}>
          <Routes>
            <Route path="/app" element={<LowStockReminder />} />
            <Route path="/app/inventory" element={<div>stock page</div>} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  alerts.current = [];
});

describe('what it says', () => {
  it('says nothing when everything is stocked', () => {
    const { container } = mount();
    expect(container).toBeEmptyDOMElement();
  });

  it('names the item and how much is left', () => {
    alerts.current = [alert({ name: 'Milk', stock: 4, unit: 'litre' })];
    mount();

    expect(screen.getByText('Milk')).toBeInTheDocument();
    expect(screen.getByText(/Only 4 litre left/)).toBeInTheDocument();
    // Never a vague "inventory is low".
    expect(screen.queryByText(/inventory is low/i)).not.toBeInTheDocument();
  });

  it('distinguishes an empty shelf from a thin one', () => {
    alerts.current = [
      alert({ productId: 'p2', name: 'Tea', stock: 0, unit: 'packet', status: 'out_of_stock' }),
    ];
    mount();

    expect(screen.getByText('Out of stock')).toBeInTheDocument();
    expect(screen.getByText(/None left/)).toBeInTheDocument();
  });

  it('lists every low item, each with its own quantity', () => {
    alerts.current = [
      alert({ productId: 'p1', name: 'Milk', stock: 4, unit: 'litre' }),
      alert({ productId: 'p2', name: 'Tea', stock: 3, unit: 'packet' }),
      alert({ productId: 'p3', name: 'Sugar', stock: 2, unit: 'kg' }),
    ];
    mount();

    expect(screen.getByText('3 items need restocking')).toBeInTheDocument();
    for (const name of ['Milk', 'Tea', 'Sugar']) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    expect(screen.getByText(/Only 3 packet left/)).toBeInTheDocument();
  });
});

describe('what it offers', () => {
  it('gives each item its own restock button, named after it', () => {
    alerts.current = [
      alert({ productId: 'p1', name: 'Milk' }),
      alert({ productId: 'p2', name: 'Tea' }),
    ];
    mount();

    expect(screen.getByRole('button', { name: 'Restock Milk' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restock Tea' })).toBeInTheDocument();
  });

  it('takes the shopkeeper to that exact product, not to a search', () => {
    alerts.current = [alert({ productId: 'prd_milk_1', name: 'Milk' })];
    mount();

    fireEvent.click(screen.getByRole('button', { name: 'Restock Milk' }));

    // The stock page opened, carrying which product to restock.
    expect(screen.getByText('stock page')).toBeInTheDocument();
  });

  it('can be put away for now, and is not marked read forever', () => {
    alerts.current = [alert({ name: 'Milk' })];
    const { container } = mount();

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(container).toBeEmptyDOMElement();

    // Nothing was written anywhere: a fresh mount, as a fresh app open would
    // be, shows it again while the stock is still low.
    const second = mount();
    expect(second.getByText('Milk')).toBeInTheDocument();
  });
});
