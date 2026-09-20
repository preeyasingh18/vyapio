import { describe, expect, it, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '@/app/providers/I18nProvider';
import { ThemeProvider } from '@/app/providers/ThemeProvider';
import { ToastProvider } from '@/app/providers/ToastProvider';
import { DraftReview } from '@/features/voice/DraftReview';
import type { TransactionDraft } from '@shared/ai';

/**
 * The confirmation screen for a spoken transaction.
 *
 * What these guard is that the screen shows the whole request. An item the shop
 * cannot supply is the single most useful thing on this card — it is what the
 * shopkeeper has to say out loud to the customer standing in front of them —
 * and it is exactly the kind of row a "show what we can sell" filter removes.
 */

vi.mock('@/app/providers/OfflineProvider', () => ({
  useOffline: () => ({ online: true, enqueue: vi.fn(), queue: [], syncing: false }),
}));

type Line = TransactionDraft['items'][number];

function line(over: Partial<Line> & Pick<Line, 'name'>): Line {
  const requested = over.requestedQuantity ?? 1;
  const available = over.availableQuantity ?? requested;
  const fulfilled = over.fulfilledQuantity ?? Math.min(requested, available);
  const unitPrice = over.unitPrice ?? 6000;

  return {
    productId: 'p1',
    unit: 'litre',
    quantity: fulfilled,
    unitPrice,
    lineTotal: unitPrice * fulfilled,
    requestedQuantity: requested,
    availableQuantity: available,
    fulfilledQuantity: fulfilled,
    availability:
      fulfilled <= 0 ? 'unavailable' : fulfilled < requested ? 'insufficient' : 'available',
    inCatalogue: true,
    ...over,
  } as Line;
}

function draftOf(items: Line[], paid = 0): TransactionDraft {
  const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
  return {
    draftId: 'd1',
    transcript: 'test',
    language: 'en',
    customerId: 'c1',
    customerName: 'Arpita Sen',
    customerIsNew: false,
    customerCandidates: [],
    items,
    subtotal,
    discount: 0,
    total: subtotal,
    paid,
    outstanding: Math.max(0, subtotal - paid),
    change: Math.max(0, paid - subtotal),
    unfulfilledCount: items.filter((item) => item.availability !== 'available').length,
    paymentMethod: 'cash',
    confidence: 0.9,
    needsReview: false,
    warnings: [],
    engine: 'local-parser',
  } as TransactionDraft;
}

function mount(draft: TransactionDraft, onChange = vi.fn()) {
  const utils = render(
    <I18nProvider>
      <ThemeProvider>
        <ToastProvider>
          <MemoryRouter>
            <DraftReview
              draft={draft}
              onChange={onChange}
              onConfirm={vi.fn()}
              onSpeakAgain={vi.fn()}
              saving={false}
              online
            />
          </MemoryRouter>
        </ToastProvider>
      </ThemeProvider>
    </I18nProvider>,
  );
  return { ...utils, onChange };
}

/* ----------------------------------------------------------------- Tests */

describe('every item reaches the screen', () => {
  it('shows both items of a two-item request', () => {
    mount(
      draftOf([
        line({ name: 'Milk', requestedQuantity: 4, availableQuantity: 10, unitPrice: 6000 }),
        line({ name: 'Tea', requestedQuantity: 3, availableQuantity: 20, unitPrice: 3000, unit: 'packet' }),
      ]),
    );

    expect(screen.getByText('Milk')).toBeInTheDocument();
    expect(screen.getByText('Tea')).toBeInTheDocument();
    expect(screen.getByText('2 items')).toBeInTheDocument();
  });

  it('scales to five items without a ceiling', () => {
    const names = ['Rice', 'Milk', 'Tea', 'Biscuits', 'Sugar'];
    mount(draftOf(names.map((name) => line({ name, requestedQuantity: 2, availableQuantity: 10 }))));

    for (const name of names) expect(screen.getByText(name)).toBeInTheDocument();
    expect(screen.getByText('5 items')).toBeInTheDocument();
  });

  it('keeps an out-of-stock item visible, marked and charged nothing', () => {
    mount(
      draftOf([
        line({ name: 'Milk', requestedQuantity: 4, availableQuantity: 10, unitPrice: 6000 }),
        line({ name: 'Tea', requestedQuantity: 3, availableQuantity: 0, unitPrice: 3000 }),
      ]),
    );

    // Present, not filtered out.
    expect(screen.getByText('Tea')).toBeInTheDocument();
    expect(screen.getByText('NOT AVAILABLE')).toBeInTheDocument();
    expect(screen.getByText(/Asked for 3 · none in stock · not charged/)).toBeInTheDocument();

    // Only the milk is charged for: 4 x 60.
    expect(screen.getByText('1 item could not be fulfilled from stock.', { exact: false }))
      .toBeInTheDocument();
  });

  it('spells out the shortfall when stock runs short', () => {
    mount(
      draftOf([
        line({ name: 'Milk', requestedQuantity: 10, availableQuantity: 6, unitPrice: 6000 }),
      ]),
    );

    expect(screen.getByText('INSUFFICIENT STOCK')).toBeInTheDocument();
    expect(
      screen.getByText(/Asked for 10 · only 6 left ·\s*short by 4/),
    ).toBeInTheDocument();
  });

  it('badges an item that can be supplied in full', () => {
    mount(draftOf([line({ name: 'Milk', requestedQuantity: 4, availableQuantity: 10 })]));
    expect(screen.getByText('AVAILABLE')).toBeInTheDocument();
  });

  it('says when a product is not in the shop list at all', () => {
    mount(
      draftOf([
        line({
          name: 'Bread',
          requestedQuantity: 3,
          availableQuantity: 0,
          unitPrice: 0,
          inCatalogue: false,
        }),
      ]),
    );

    expect(screen.getByText('Bread')).toBeInTheDocument();
    expect(screen.getByText(/not in your stock list/)).toBeInTheDocument();
  });
});

describe('the money', () => {
  it('charges only for what can be supplied', () => {
    // 4 milk at 60 = 240, tea unavailable, 2 sugar at 50 = 100 -> 340.
    mount(
      draftOf([
        line({ name: 'Milk', requestedQuantity: 4, availableQuantity: 10, unitPrice: 6000 }),
        line({ name: 'Tea', requestedQuantity: 3, availableQuantity: 0, unitPrice: 3000 }),
        line({ name: 'Sugar', requestedQuantity: 2, availableQuantity: 5, unitPrice: 5000 }),
      ]),
    );

    const confirm = screen.getByRole('button', { name: /confirm/i });
    expect(confirm.textContent).toMatch(/₹340/);
  });

  it('shows change rather than a negative balance when overpaid', () => {
    mount(draftOf([line({ name: 'Milk', requestedQuantity: 4, availableQuantity: 10 })], 40_000));

    expect(screen.getByText('Change to return')).toBeInTheDocument();
    expect(screen.getByText('₹160')).toBeInTheDocument();
    expect(screen.queryByText(/-₹/)).not.toBeInTheDocument();
  });

  it('shows what is still owed when underpaid', () => {
    mount(draftOf([line({ name: 'Milk', requestedQuantity: 4, availableQuantity: 10 })], 10_000));

    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.queryByText('Change to return')).not.toBeInTheDocument();
  });

  it('will not confirm a sale where nothing is in stock', () => {
    mount(
      draftOf([
        line({ name: 'Tea', requestedQuantity: 3, availableQuantity: 0, unitPrice: 3000 }),
      ]),
    );

    expect(screen.getByRole('button', { name: /confirm/i })).toBeDisabled();
    expect(screen.getByText(/nothing here is in stock/i)).toBeInTheDocument();
  });
});

describe('editing a line', () => {
  it('re-derives the badge from the corrected quantity', () => {
    const { onChange } = mount(
      draftOf([
        line({ name: 'Milk', requestedQuantity: 10, availableQuantity: 6, unitPrice: 6000 }),
      ]),
    );

    fireEvent.click(within(screen.getByText('1 item').parentElement!).getByText(/edit/i));
    fireEvent.change(screen.getByLabelText('Milk quantity'), { target: { value: '5' } });

    const next = onChange.mock.calls.at(-1)![0] as TransactionDraft;
    expect(next.items[0]).toMatchObject({
      quantity: 5,
      fulfilledQuantity: 5,
      // 5 of the 6 on the shelf: no longer short.
      availability: 'available',
      lineTotal: 30_000,
    });
    expect(next.total).toBe(30_000);
  });
});


/**
 * A customer the shop has not saved yet.
 *
 * The draft says "New — will be created" against an unrecognised name, so the
 * confirm button has to honour that. It did not: it stayed disabled with "Pick
 * a customer to continue", which left the only way forward as abandoning the
 * sale, adding the person by hand and saying the whole thing again — with a
 * customer standing at the counter.
 */
describe('confirming a sale for someone new', () => {
  const newPerson = (over: Partial<TransactionDraft> = {}) =>
    ({
      ...draftOf([line({ name: 'Milk', requestedQuantity: 2, availableQuantity: 10 })]),
      customerId: null,
      customerName: 'ईशा',
      customerIsNew: true,
      ...over,
    }) as TransactionDraft;

  it('lets the sale be confirmed', () => {
    mount(newPerson());
    expect(screen.getByRole('button', { name: /confirm/i })).toBeEnabled();
  });

  it('still refuses when no name was heard at all', () => {
    // Nothing to create them under, so there is genuinely nobody to charge.
    mount(newPerson({ customerName: '', customerIsNew: false }));

    expect(screen.getByRole('button', { name: /confirm/i })).toBeDisabled();
    // The card carries its own "no name was heard" note, so match the hint
    // under the button exactly rather than anything mentioning a customer.
    expect(screen.getByText('Pick a customer to continue')).toBeInTheDocument();
  });

  it('refuses a name with nothing but spaces in it', () => {
    mount(newPerson({ customerName: '   ' }));
    expect(screen.getByRole('button', { name: /confirm/i })).toBeDisabled();
  });

  it('still refuses when nothing in the order is in stock', () => {
    // A new customer does not rescue a sale with nothing to sell.
    const draft = newPerson();
    const empty = {
      ...draft,
      items: [line({ name: 'Tea', requestedQuantity: 3, availableQuantity: 0, unitPrice: 3000 })],
    } as TransactionDraft;
    mount(empty);

    expect(screen.getByRole('button', { name: /confirm/i })).toBeDisabled();
    expect(screen.getByText(/nothing here is in stock/i)).toBeInTheDocument();
  });
});
