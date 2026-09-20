import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nProvider } from '@/app/providers/I18nProvider';
import { SaleStatus } from '@/components/money/SaleStatus';

/**
 * Where a sale stands, on every screen that shows one.
 *
 * A customer cleared her ₹600 bill and the sales list still badged the row
 * "₹600 pending", because the row carried the sale's frozen `outstanding`
 * rather than its live balance. The header above it already read ₹0
 * outstanding, so the shopkeeper was shown two contradictory numbers and would
 * have gone and asked a customer for money she had already handed over.
 *
 * These tests are about what the shopkeeper reads, not about how it is styled.
 */

const PAID_AT = '2026-09-20T07:06:26.000Z';

function mount(props: Parameters<typeof SaleStatus>[0]) {
  return render(
    <I18nProvider>
      <SaleStatus {...props} />
    </I18nProvider>,
  );
}

describe('a settled sale', () => {
  it('reads as paid, never as pending', () => {
    mount({ pending: 0, paidAt: PAID_AT, total: 60000 });

    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.queryByText(/pending/i)).not.toBeInTheDocument();
  });

  it('says when the money came in', () => {
    // "Paid" with no date is a claim the shopkeeper cannot check against what
    // the customer remembers.
    mount({ pending: 0, paidAt: PAID_AT, total: 60000 });

    expect(screen.getByText(/Today|Sep|Yesterday/)).toBeInTheDocument();
  });

  it('manages without a date, rather than inventing one', () => {
    mount({ pending: 0, paidAt: null, total: 60000 });
    expect(screen.getByText('Paid')).toBeInTheDocument();
  });
});

describe('a sale still owed', () => {
  it('shows what is left, not what was owed on the day', () => {
    mount({ pending: 34000, paidAt: null, total: 72000 });

    expect(screen.getByText(/₹340\s*pending/)).toBeInTheDocument();
    expect(screen.queryByText('Paid')).not.toBeInTheDocument();
  });

  it('shows how much has come in, and when, while it is part paid', () => {
    mount({ pending: 38000, paidAt: PAID_AT, total: 72000 });

    // Still owed…
    expect(screen.getByText(/₹380\s*pending/)).toBeInTheDocument();
    // …but ₹340 of it has been handed over. That is what the shopkeeper is
    // about to be asked about, so both halves have to be on the row.
    expect(screen.getByText(/₹340\s*part paid/)).toBeInTheDocument();
  });

  it('adds no payment date when nothing has been paid', () => {
    mount({ pending: 34000, paidAt: null, total: 34000 });
    expect(screen.queryByText(/part paid/)).not.toBeInTheDocument();
  });
});

describe('both layouts', () => {
  it('says the same thing on a phone card as in a table row', () => {
    const props = { pending: 0, paidAt: PAID_AT, total: 60000 } as const;

    const { unmount } = mount({ ...props });
    const badge = screen.getByText('Paid').textContent;
    unmount();

    mount({ ...props, variant: 'plain' });
    expect(screen.getByText('Paid').textContent).toBe(badge);
  });
});
