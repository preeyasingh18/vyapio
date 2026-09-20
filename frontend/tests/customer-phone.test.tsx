import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { I18nProvider } from '@/app/providers/I18nProvider';
import { ThemeProvider } from '@/app/providers/ThemeProvider';
import { ToastProvider } from '@/app/providers/ToastProvider';

/**
 * Giving a customer a phone number.
 *
 * Most customers are created by voice in the middle of a sale, where nobody
 * stops to type a number. Until now the only field that accepted one was on the
 * form that creates a customer, so those people stayed unreachable for good —
 * and a shop's entire follow-up, from a reminder about money owed to a call
 * when an order is ready, needs a number.
 *
 * The number goes onto the customer record that already has a `phone` field,
 * through the update endpoint that already exists. These tests are about what
 * the shopkeeper can do, and about what actually gets sent.
 */

const patch = vi.fn();
const refetch = vi.fn();
let customer: Record<string, unknown>;

vi.mock('@/hooks/useApi', () => ({
  useQuery: () => ({
    data: {
      customer,
      summary: {
        totalSpent: 37500,
        purchaseCount: 1,
        outstanding: 0,
        openCommitments: 0,
        overdueAmount: 0,
        lastInteractionAt: null,
      },
      timeline: [],
      commitments: [],
    },
    loading: false,
    error: null,
    refetch,
    setData: vi.fn(),
  }),
}));

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, api: { ...actual.api, patch: (...args: unknown[]) => patch(...args) } };
});

vi.mock('@/app/providers/OfflineProvider', () => ({
  useOffline: () => ({ online: true, enqueue: vi.fn(), queue: [], syncing: false }),
}));

function makeCustomer(phone: unknown): Record<string, unknown> {
  return {
    customerId: 'cus_1',
    vendorId: 'v1',
    name: 'Arpita',
    phone,
    whatsappPhone: '',
    whatsappOptIn: false,
    email: '',
    qrId: 'qr_1',
    outstanding: 0,
    totalSpent: 37500,
    transactionCount: 1,
    notes: '',
    createdAt: '2026-09-20T06:00:00.000Z',
    updatedAt: '2026-09-20T06:00:00.000Z',
  };
}

async function mount() {
  const { default: CustomerDetailPage } = await import('@/features/customers/CustomerDetailPage');
  return render(
    <I18nProvider>
      <ThemeProvider>
        <ToastProvider>
          <MemoryRouter initialEntries={['/app/customers/cus_1']}>
            <Routes>
              <Route path="/app/customers/:customerId" element={<CustomerDetailPage />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </ThemeProvider>
    </I18nProvider>,
  );
}

const openAdd = () => fireEvent.click(screen.getByRole('button', { name: /add phone number/i }));
const openEdit = () => fireEvent.click(screen.getByRole('button', { name: /edit phone number/i }));
// Exact: the add and edit controls are labelled "…phone number" too.
const field = () => screen.getByLabelText('Phone number');

beforeEach(() => {
  patch.mockReset();
  patch.mockResolvedValue({ customer: makeCustomer('9876543210') });
  refetch.mockReset();
  customer = makeCustomer('');
});

describe('a customer with no number', () => {
  it('offers a way to add one', async () => {
    await mount();
    expect(screen.getByRole('button', { name: /add phone number/i })).toBeInTheDocument();
  });

  it('treats a record written before the field existed as having none', async () => {
    // Customers saved before `phone` existed come back without the key at all.
    // That is "no number" — not a crash, and not a blank number on screen.
    customer = makeCustomer(undefined);
    await mount();

    expect(screen.getByRole('button', { name: /add phone number/i })).toBeInTheDocument();
  });

  it('opens on an empty field', async () => {
    await mount();
    openAdd();

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(field()).toHaveValue('');
  });

  it('saves onto the customer that already exists', async () => {
    await mount();
    openAdd();
    fireEvent.change(field(), { target: { value: '9876543210' } });
    fireEvent.click(screen.getByRole('button', { name: /save number/i }));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    // The existing record, not a new customer and not a store of its own.
    expect(patch).toHaveBeenCalledWith('/customers/cus_1', {
      phone: '9876543210',
      whatsappPhone: '',
      whatsappOptIn: false,
    });
  });

  it('re-reads the customer afterwards instead of believing itself', async () => {
    await mount();
    openAdd();
    fireEvent.change(field(), { target: { value: '9876543210' } });
    fireEvent.click(screen.getByRole('button', { name: /save number/i }));

    await waitFor(() => expect(refetch).toHaveBeenCalled());
  });
});

describe('a customer who has a number', () => {
  beforeEach(() => {
    customer = makeCustomer('9876543210');
  });

  it('shows it grouped the way a number is read aloud', async () => {
    await mount();
    expect(screen.getByText('+91 98765 43210')).toBeInTheDocument();
  });

  it('makes it callable rather than merely readable', async () => {
    await mount();
    // On the phone the shopkeeper is holding, this is the whole point.
    expect(screen.getByRole('link', { name: /call arpita/i })).toHaveAttribute(
      'href',
      'tel:+919876543210',
    );
  });

  it('offers no "add" action, because there is nothing to add', async () => {
    await mount();
    expect(screen.queryByRole('button', { name: /add phone number/i })).not.toBeInTheDocument();
  });

  it('opens pre-filled, so a correction is a correction', async () => {
    await mount();
    openEdit();

    expect(field()).toHaveValue('9876543210');
  });
});

describe('what the shopkeeper types', () => {
  it('refuses a short number, and sends nothing', async () => {
    await mount();
    openAdd();
    fireEvent.change(field(), { target: { value: '12345' } });
    fireEvent.click(screen.getByRole('button', { name: /save number/i }));

    expect(await screen.findByText(/valid 10-digit mobile number/i)).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
  });

  it('refuses one that cannot be an Indian mobile', async () => {
    // The API stores numbers starting 6-9. Accepting "1234567890" here would
    // only move the rejection to the server.
    await mount();
    openAdd();
    fireEvent.change(field(), { target: { value: '1234567890' } });
    fireEvent.click(screen.getByRole('button', { name: /save number/i }));

    expect(await screen.findByText(/valid 10-digit mobile number/i)).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
  });

  it('still saves for a record written before WhatsApp fields existed', async () => {
    /**
     * Those customers come back with no `whatsappPhone` key at all.
     *
     * Treating `undefined` as "not empty" made the optional WhatsApp field
     * fail its own validation, which blocked saving the ordinary phone number
     * — a field the shopkeeper had filled in correctly, refused because of a
     * second field they had never seen.
     */
    customer = { ...makeCustomer(''), whatsappPhone: undefined, whatsappOptIn: undefined };
    await mount();
    openAdd();
    fireEvent.change(field(), { target: { value: '9876543210' } });
    fireEvent.click(screen.getByRole('button', { name: /save number/i }));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
  });

  it('keeps letters out of the field entirely', async () => {
    await mount();
    openAdd();
    fireEvent.change(field(), { target: { value: '98abc76543210xyz' } });

    expect(field()).toHaveValue('9876543210');
  });

  it('does not let a pasted +91 be stored twice', async () => {
    await mount();
    openAdd();
    fireEvent.change(field(), { target: { value: '+91 98765 43210' } });

    // The field already shows +91, so the country code must not survive into
    // the value — "919876543210" is a different number.
    expect(field()).not.toHaveValue('919876543210');
  });
});

describe('backing out', () => {
  beforeEach(() => {
    customer = makeCustomer('9876543210');
  });

  it('changes nothing when cancelled', async () => {
    await mount();
    openEdit();
    fireEvent.change(field(), { target: { value: '9000000000' } });
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(patch).not.toHaveBeenCalled();
    expect(screen.getByText('+91 98765 43210')).toBeInTheDocument();
  });

  it('forgets an abandoned edit when reopened', async () => {
    await mount();
    openEdit();
    fireEvent.change(field(), { target: { value: '9000000000' } });
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    openEdit();
    // The saved number, not the one that was walked away from.
    expect(field()).toHaveValue('9876543210');
  });
});
