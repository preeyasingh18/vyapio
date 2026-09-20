import { useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Check, Plus, Search, Trash2 } from 'lucide-react';
import { PageBody, PageHeader } from '@/components/layout/PageHeader';
import { Avatar, Button, Card, Input, Select, Sheet } from '@/components/ui';
import { PageTransition } from '@/components/motion';
import { useT } from '@/app/providers/I18nProvider';
import { useToast } from '@/app/providers/ToastProvider';
import { useOffline } from '@/app/providers/OfflineProvider';
import { useQuery } from '@/hooks/useApi';
import { api, ApiError } from '@/lib/api';
import { formatMoney, formatPhone } from '@/lib/format';
import { PAYMENT_METHODS, type PaymentMethod } from '@shared/common';
import type { Customer, Product } from '@shared/entities';

/**
 * Manual sale entry.
 *
 * The keyboard fallback for the voice flow, and the screen a shopkeeper uses
 * when the shop is noisy. Same domain rules, same confirmation — it just
 * collects the fields by tapping instead of by speaking.
 */

type Line = {
  key: string;
  productId?: string;
  name: string;
  quantity: number;
  unit: string;
  unitPrice: number;
};

export default function NewSalePage() {
  const t = useT();
  const navigate = useNavigate();
  const toast = useToast();
  const { online, enqueue } = useOffline();
  const [params] = useSearchParams();

  const [chosenCustomer, setChosenCustomer] = useState<Customer | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [paidRupees, setPaidRupees] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [customerSheet, setCustomerSheet] = useState(false);
  const [productSheet, setProductSheet] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const { data: customersData } = useQuery<{ customers: Customer[] }>('/customers');
  const { data: productsData } = useQuery<{ products: Product[] }>('/inventory');

  /**
   * Pre-selected when arriving from a customer's page.
   *
   * Derived rather than synced through an effect: the selection is a pure
   * function of the query string and the loaded list, and an explicit choice
   * simply takes precedence.
   */
  const presetId = params.get('customerId');
  const customer = useMemo(() => {
    if (chosenCustomer) return chosenCustomer;
    if (!presetId || !customersData) return null;
    return customersData.customers.find((entry) => entry.customerId === presetId) ?? null;
  }, [chosenCustomer, presetId, customersData]);

  const subtotal = lines.reduce((sum, line) => sum + Math.round(line.unitPrice * line.quantity), 0);
  const paid = Math.min(Math.round((Number(paidRupees) || 0) * 100), subtotal);
  const outstanding = subtotal - paid;
  const canSave = customer !== null && lines.length > 0;

  const addProduct = (product: Product) => {
    setLines((current) => [
      ...current,
      {
        key: crypto.randomUUID(),
        productId: product.productId,
        name: product.name,
        quantity: 1,
        unit: product.unit,
        unitPrice: product.sellingPrice,
      },
    ]);
    setProductSheet(false);
  };

  const updateLine = (key: string, patch: Partial<Line>) => {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  };

  /**
   * One key per sale being composed, not per click.
   *
   * Generated once and held until a save succeeds, so a double tap or a retry
   * after a dropped connection is recognised by the server as the same sale
   * rather than deducting the stock a second time.
   */
  const attemptKey = useRef(crypto.randomUUID());

  const save = async () => {
    if (!canSave || !customer) return;

    const payload = {
      customerId: customer.customerId,
      items: lines.map((line) => ({
        ...(line.productId ? { productId: line.productId } : {}),
        name: line.name,
        quantity: line.quantity,
        unit: line.unit,
        unitPrice: line.unitPrice,
      })),
      discount: 0,
      paid,
      paymentMethod: method,
      note: '',
      source: 'manual' as const,
    };

    if (!online) {
      enqueue({
        kind: 'transaction',
        payload,
        label: `${customer.name} · ${formatMoney(subtotal)}`,
      });
      toast.info(t('offline.notSavedYet'), `${customer.name} · ${formatMoney(subtotal)}`);
      navigate(`/app/customers/${customer.customerId}`);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await api.post('/transactions', payload, { idempotencyKey: attemptKey.current });
      attemptKey.current = crypto.randomUUID();
      toast.success(t('sales.recorded'), `${customer.name} · ${formatMoney(subtotal)}`);
      navigate(`/app/customers/${customer.customerId}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageTransition>
      <PageHeader title={t('sales.new')} back />

      <PageBody className="pb-32">
        {/* Customer */}
        <button
          type="button"
          onClick={() => setCustomerSheet(true)}
          className="flex w-full items-center gap-3.5 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-4 text-left shadow-[var(--shadow-card)]"
        >
          {customer ? (
            <>
              <Avatar name={customer.name} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-bold text-[var(--color-ink)]">
                  {customer.name}
                </span>
                <span className="block truncate text-xs text-[var(--color-muted)]">
                  {customer.phone ? formatPhone(customer.phone) : '—'}
                  {customer.outstanding > 0
                    ? ` · ${formatMoney(customer.outstanding)} ${t('customers.owes')}`
                    : ''}
                </span>
              </span>
            </>
          ) : (
            <>
              <span className="flex size-10 items-center justify-center rounded-full bg-[var(--color-sunken)] text-[var(--color-muted)]">
                <Plus className="size-5" aria-hidden="true" />
              </span>
              <span className="text-sm font-semibold text-[var(--color-muted)]">
                {t('sales.selectCustomer')}
              </span>
            </>
          )}
        </button>

        {/* Items */}
        <Card className="mt-4 overflow-hidden">
          {lines.length === 0 ? (
            <p className="p-5 text-center text-sm text-[var(--color-muted)]">
              No items yet
            </p>
          ) : (
            <div className="divide-y divide-[var(--color-line)]">
              {lines.map((line) => (
                <div key={line.key} className="p-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <p className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--color-ink)]">
                      {line.name}
                    </p>
                    <span className="text-sm font-bold text-[var(--color-ink)] tabular">
                      {formatMoney(Math.round(line.unitPrice * line.quantity))}
                    </span>
                    <button
                      type="button"
                      onClick={() => setLines((current) => current.filter((entry) => entry.key !== line.key))}
                      className="-m-1 rounded-[var(--radius-control)] p-1 text-[var(--color-faint)] transition-colors hover:text-[var(--color-danger)]"
                      aria-label={`Remove ${line.name}`}
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                    </button>
                  </div>

                  <div className="mt-2 flex gap-2">
                    <Input
                      type="number"
                      inputMode="decimal"
                      value={String(line.quantity)}
                      onChange={(event) =>
                        updateLine(line.key, { quantity: Number(event.target.value) || 0 })
                      }
                      className="h-10 text-sm"
                      suffix={line.unit}
                      aria-label={`${line.name} ${t('sales.quantity')}`}
                    />
                    <Input
                      type="number"
                      inputMode="decimal"
                      value={String(line.unitPrice / 100)}
                      onChange={(event) =>
                        updateLine(line.key, {
                          unitPrice: Math.round((Number(event.target.value) || 0) * 100),
                        })
                      }
                      className="h-10 text-sm"
                      prefix="₹"
                      aria-label={`${line.name} ${t('sales.unitPrice')}`}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={() => setProductSheet(true)}
            className="flex w-full items-center justify-center gap-2 border-t border-[var(--color-line)] py-3.5 text-sm font-semibold text-[var(--color-primary)] transition-colors active:bg-[var(--color-sunken)]"
          >
            <Plus className="size-4" aria-hidden="true" />
            {t('sales.addItem')}
          </button>
        </Card>

        {/* Money */}
        <Card className="mt-4 p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-[var(--color-muted)]">{t('common.total')}</span>
            <span className="text-xl font-extrabold text-[var(--color-ink)] tabular">
              {formatMoney(subtotal)}
            </span>
          </div>

          <div className="mt-4 space-y-3">
            <Input
              type="number"
              inputMode="decimal"
              label={t('sales.amountPaid')}
              value={paidRupees}
              onChange={(event) => setPaidRupees(event.target.value)}
              prefix="₹"
              placeholder="0"
            />

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPaidRupees(String(subtotal / 100))}
                className="rounded-[var(--radius-control)] bg-[var(--color-sunken)] px-3 py-1.5 text-xs font-semibold text-[var(--color-ink-soft)]"
              >
                Paid in full
              </button>
              <button
                type="button"
                onClick={() => {
                  setPaidRupees('0');
                  setMethod('credit');
                }}
                className="rounded-[var(--radius-control)] bg-[var(--color-sunken)] px-3 py-1.5 text-xs font-semibold text-[var(--color-ink-soft)]"
              >
                All on credit
              </button>
            </div>

            <Select
              label={t('sales.paymentMethod')}
              value={method}
              onChange={(event) => setMethod(event.target.value as PaymentMethod)}
            >
              {PAYMENT_METHODS.map((entry) => (
                <option key={entry} value={entry}>
                  {t(`payments.${entry}`)}
                </option>
              ))}
            </Select>
          </div>

          {outstanding > 0 ? (
            <p className="mt-3 rounded-[var(--radius-field)] bg-[var(--color-warning-soft)] px-3 py-2.5 text-sm font-semibold text-[var(--color-warning)]">
              {formatMoney(outstanding)} {t('common.pending').toLowerCase()} — added to their khata
            </p>
          ) : null}

          {error ? (
            <p
              className="mt-3 rounded-[var(--radius-field)] bg-[var(--color-danger-soft)] px-3 py-2.5 text-sm text-[var(--color-danger)]"
              role="alert"
            >
              {error.message}
            </p>
          ) : null}
        </Card>
      </PageBody>

      {/* Sticky save — reachable without scrolling back up. */}
      <div className="glass fixed inset-x-0 bottom-0 z-30 border-t border-[var(--color-line)] p-4 pb-[calc(env(safe-area-inset-bottom)+5.5rem)] lg:pb-4">
        <div className="mx-auto max-w-5xl">
          <Button
            size="lg"
            block
            loading={saving}
            disabled={!canSave}
            onClick={() => void save()}
            icon={<Check className="size-4" />}
          >
            {online ? `${t('sales.record')} · ${formatMoney(subtotal)}` : t('offline.notSavedYet')}
          </Button>
        </div>
      </div>

      <PickerSheet
        open={customerSheet}
        onClose={() => setCustomerSheet(false)}
        title={t('sales.selectCustomer')}
        items={customersData?.customers ?? []}
        keyOf={(entry) => entry.customerId}
        searchOf={(entry) => `${entry.name} ${entry.phone}`}
        onPick={(entry) => {
          setChosenCustomer(entry);
          setCustomerSheet(false);
        }}
        render={(entry) => (
          <>
            <Avatar name={entry.name} size="sm" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-[var(--color-ink)]">
                {entry.name}
              </span>
              <span className="block truncate text-xs text-[var(--color-muted)]">
                {entry.phone ? formatPhone(entry.phone) : '—'}
              </span>
            </span>
            {entry.outstanding > 0 ? (
              <span className="shrink-0 text-xs font-semibold text-[var(--color-warning)] tabular">
                {formatMoney(entry.outstanding)}
              </span>
            ) : null}
          </>
        )}
      />

      <PickerSheet
        open={productSheet}
        onClose={() => setProductSheet(false)}
        title={t('sales.addItem')}
        items={productsData?.products ?? []}
        keyOf={(entry) => entry.productId}
        searchOf={(entry) => `${entry.name} ${entry.aliases.join(' ')}`}
        onPick={addProduct}
        render={(entry) => (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-[var(--color-ink)]">
                {entry.name}
              </span>
              <span className="block text-xs text-[var(--color-muted)]">
                {entry.stock} {entry.unit} in stock
              </span>
            </span>
            <span className="shrink-0 text-sm font-bold text-[var(--color-ink)] tabular">
              {formatMoney(entry.sellingPrice)}
            </span>
          </>
        )}
      />
    </PageTransition>
  );
}

/** Generic searchable picker used for both customers and products. */
function PickerSheet<T>({
  open,
  onClose,
  title,
  items,
  keyOf,
  searchOf,
  onPick,
  render,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  items: T[];
  keyOf: (item: T) => string;
  searchOf: (item: T) => string;
  onPick: (item: T) => void;
  render: (item: T) => React.ReactNode;
}) {
  const t = useT();
  const [search, setSearch] = useState('');

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) => searchOf(item).toLowerCase().includes(needle));
  }, [items, search, searchOf]);

  return (
    <Sheet open={open} onClose={onClose} title={title} size="md">
      <Input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder={t('common.search')}
        prefix={<Search className="size-4" />}
        type="search"
        autoFocus
      />

      <div className="mt-3 max-h-[50dvh] space-y-1 overflow-y-auto pb-2">
        {visible.length === 0 ? (
          <p className="py-8 text-center text-sm text-[var(--color-muted)]">No matches</p>
        ) : (
          visible.map((item) => (
            <button
              key={keyOf(item)}
              type="button"
              onClick={() => onPick(item)}
              className="flex w-full items-center gap-3 rounded-[var(--radius-field)] p-2.5 text-left transition-colors active:bg-[var(--color-sunken)]"
            >
              {render(item)}
            </button>
          ))
        )}
      </div>
    </Sheet>
  );
}
