import { useMemo, useState } from 'react';
import { Plus, UserPlus, Users } from 'lucide-react';
import { PageBody, PageHeader } from '@/components/layout/PageHeader';
import {
  Avatar,
  Button,
  EmptyState,
  Input,
  Panel,
  SearchBar,
  Sheet,
  Skeleton,
  StatusBadge,
  Table,
  Tabs,
} from '@/components/ui';
import { PageTransition } from '@/components/motion';
import { useT } from '@/app/providers/I18nProvider';
import { useToast } from '@/app/providers/ToastProvider';
import { useOffline } from '@/app/providers/OfflineProvider';
import { useQuery } from '@/hooks/useApi';
import { api, ApiError } from '@/lib/api';
import { formatMoney, formatMoneyCompact, formatPhone, formatRelativeDays } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { Customer } from '@shared/entities';

/**
 * The server splits each balance into what is merely unpaid and what is
 * already late, so the list can rank a fortnight-overdue ₹1,000 above the
 * same amount that falls due next week.
 */
type CustomerRow = Customer & { overdueAmount: number; overdueCount: number };

type CustomersResponse = {
  customers: CustomerRow[];
  totals: { count: number; outstanding: number; overdue: number; overdueCount: number };
};

type Filter = 'all' | 'owing' | 'recent';

export default function CustomersPage() {
  const t = useT();
  const toast = useToast();
  const { online, enqueue } = useOffline();

  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [addOpen, setAddOpen] = useState(false);

  const { data, loading, error, refetch } = useQuery<CustomersResponse>('/customers', {
    query: { filter },
  });

  // Filtering happens client-side so typing feels instant on a list of a few
  // hundred; the server filter is there for the larger shops.
  const visible = useMemo(() => {
    if (!data) return [];
    const needle = search.trim().toLowerCase();
    if (!needle) return data.customers;
    return data.customers.filter(
      (customer) =>
        customer.name.toLowerCase().includes(needle) || customer.phone.includes(needle),
    );
  }, [data, search]);

  return (
    <PageTransition>
      <PageHeader
        title={t('customers.title')}
        stats={
          data
            ? [
                { label: t('customers.countLabel'), value: data.totals.count },
                {
                  label: t('customers.outstandingLabel'),
                  value: formatMoneyCompact(data.totals.outstanding),
                  tone: data.totals.outstanding > 0 ? 'warning' : 'default',
                },
                ...(data.totals.overdue > 0
                  ? [
                      {
                        label: t('payments.overdue').toLowerCase(),
                        value: formatMoneyCompact(data.totals.overdue),
                        tone: 'danger' as const,
                      },
                    ]
                  : []),
              ]
            : undefined
        }
        actions={
          <Button size="sm" onClick={() => setAddOpen(true)} icon={<Plus className="size-4" />}>
            <span className="hidden sm:inline">{t('customers.add')}</span>
          </Button>
        }
      />

      <PageBody>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <SearchBar
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onClear={() => setSearch('')}
            placeholder={t('customers.search')}
            aria-label={t('customers.search')}
            className="sm:max-w-xs"
          />

          <div className="overflow-x-auto no-scrollbar">
            <Tabs
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: t('customers.filterAll') },
                { value: 'owing', label: t('customers.filterOwing') },
                { value: 'recent', label: t('customers.filterRecent') },
              ]}
            />
          </div>
        </div>

        <div className="mt-4">
          {loading && !data ? (
            <Panel inset className="space-y-3">
              {Array.from({ length: 8 }).map((_, index) => (
                <Skeleton key={index} className="h-10" />
              ))}
            </Panel>
          ) : error ? (
            <Panel inset className="text-center">
              <p className="text-sm text-[var(--color-muted)]">{error.message}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => void refetch()}>
                {t('common.retry')}
              </Button>
            </Panel>
          ) : (
            <Panel className="px-4 sm:px-5">
              <Table
                rows={visible}
                getKey={(customer) => customer.customerId}
                getHref={(customer) => `/app/customers/${customer.customerId}`}
                rowLabel={(customer) => customer.name}
                empty={
                  <EmptyState
                    icon={<Users className="size-6" />}
                    title={search ? t('customers.noMatches') : t('customers.empty')}
                    body={search ? undefined : t('customers.emptyBody')}
                    action={
                      search ? null : (
                        <Button
                          onClick={() => setAddOpen(true)}
                          icon={<UserPlus className="size-4" />}
                        >
                          {t('customers.add')}
                        </Button>
                      )
                    }
                  />
                }
                columns={[
                  {
                    key: 'name',
                    header: t('customers.columnCustomer'),
                    cell: (customer) => (
                      <div className="flex items-center gap-3">
                        <Avatar name={customer.name} size="sm" />
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-[var(--color-ink)]">
                            {customer.name}
                          </p>
                          <p className="truncate text-xs text-[var(--color-muted)]">
                            {customer.phone ? formatPhone(customer.phone) : '—'}
                          </p>
                        </div>
                      </div>
                    ),
                  },
                  {
                    key: 'spent',
                    header: t('customers.columnPurchases'),
                    align: 'right',
                    hideBelow: 'lg',
                    width: '18%',
                    cell: (customer) => (
                      <span className="text-[var(--color-ink-soft)] tabular">
                        {formatMoney(customer.totalSpent)}
                      </span>
                    ),
                  },
                  {
                    key: 'outstanding',
                    header: t('customers.columnOutstanding'),
                    align: 'right',
                    width: '18%',
                    cell: (customer) =>
                      customer.outstanding > 0 ? (
                        <>
                          <span
                            className={cn(
                              'font-bold tabular',
                              customer.overdueAmount > 0
                                ? 'text-[var(--color-danger)]'
                                : 'text-[var(--color-warning)]',
                            )}
                          >
                            {formatMoney(customer.outstanding)}
                          </span>
                          {/* The late portion, named. A total alone does not
                              say who to chase first. */}
                          {customer.overdueAmount > 0 &&
                          customer.overdueAmount < customer.outstanding ? (
                            <span className="block text-[11px] font-semibold text-[var(--color-danger)] tabular">
                              {formatMoney(customer.overdueAmount)} {t('payments.overdue').toLowerCase()}
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <span className="text-[var(--color-faint)]">—</span>
                      ),
                  },
                  {
                    key: 'last',
                    header: t('customers.columnLastVisit'),
                    align: 'right',
                    hideBelow: 'xl',
                    width: '16%',
                    cell: (customer) => (
                      <span className="text-xs text-[var(--color-muted)]">
                        {customer.lastInteractionAt
                          ? formatRelativeDays(customer.lastInteractionAt)
                          : '—'}
                      </span>
                    ),
                  },
                  {
                    key: 'status',
                    header: t('customers.columnStatus'),
                    align: 'right',
                    width: '14%',
                    cell: (customer) =>
                      customer.overdueAmount > 0 ? (
                        <StatusBadge tone="danger">{t('payments.overdue')}</StatusBadge>
                      ) : customer.outstanding > 0 ? (
                        <StatusBadge tone="warning">{t('customers.statusOwes')}</StatusBadge>
                      ) : (
                        <StatusBadge tone="success">{t('customers.statusClear')}</StatusBadge>
                      ),
                  },
                ]}
                renderCard={(customer) => (
                  <div className="flex items-center gap-3 py-3">
                    <Avatar name={customer.name} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-[var(--color-ink)]">
                        {customer.name}
                      </p>
                      <p className="truncate text-xs text-[var(--color-muted)]">
                        {customer.phone ? formatPhone(customer.phone) : '—'}
                        {customer.lastInteractionAt
                          ? ` · ${formatRelativeDays(customer.lastInteractionAt)}`
                          : ''}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      {customer.outstanding > 0 ? (
                        <>
                          <p
                            className={cn(
                              'text-sm font-bold tabular',
                              customer.overdueAmount > 0
                                ? 'text-[var(--color-danger)]'
                                : 'text-[var(--color-warning)]',
                            )}
                          >
                            {formatMoney(customer.outstanding)}
                          </p>
                          {customer.overdueAmount > 0 ? (
                            <p className="mt-0.5 text-[11px] font-semibold text-[var(--color-danger)]">
                              {t('payments.overdue')}
                            </p>
                          ) : (
                            <p className="mt-0.5 text-[11px] text-[var(--color-muted)]">
                              {t('customers.totalDue').toLowerCase()}
                            </p>
                          )}
                        </>
                      ) : (
                        <p className="text-xs text-[var(--color-faint)]">
                          {t('customers.noPending')}
                        </p>
                      )}
                    </div>
                  </div>
                )}
              />
            </Panel>
          )}
        </div>
      </PageBody>

      <AddCustomerSheet
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={() => void refetch()}
        online={online}
        enqueue={enqueue}
        toast={toast}
      />
    </PageTransition>
  );
}

/**
 * Add customer.
 *
 * Works offline: the customer is queued and the sheet says so explicitly rather
 * than showing a success message for something that has not been saved.
 */
function AddCustomerSheet({
  open,
  onClose,
  onCreated,
  online,
  enqueue,
  toast,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  online: boolean;
  enqueue: (input: { kind: 'customer'; payload: Record<string, unknown>; label: string }) => void;
  toast: ReturnType<typeof useToast>;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setName('');
    setPhone('');
    setError(null);
  };

  const submit = async () => {
    if (!name.trim()) return;
    const payload = { name: name.trim(), phone: phone.replace(/\D/g, '') };

    if (!online) {
      enqueue({ kind: 'customer', payload, label: `Add ${payload.name}` });
      toast.info(t('offline.notSavedYet'), payload.name);
      reset();
      onClose();
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await api.post('/customers', payload);
      toast.success(t('scanner.memoryCreated'), payload.name);
      reset();
      onClose();
      onCreated();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('customers.add')}
      footer={
        <Button size="lg" block loading={busy} disabled={!name.trim()} onClick={() => void submit()}>
          {online ? t('common.save') : t('offline.notSavedYet')}
        </Button>
      }
    >
      <div className="space-y-4 pb-2">
        <Input
          label={t('auth.name')}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Ramesh Kumar"
          autoFocus
          {...(error?.issueFor('name') ? { error: error.issueFor('name') } : {})}
        />

        <Input
          type="tel"
          inputMode="numeric"
          label={`${t('auth.phone')} (${t('common.optional')})`}
          value={phone}
          onChange={(event) => setPhone(event.target.value.replace(/\D/g, '').slice(0, 10))}
          prefix="+91"
          placeholder="98765 43210"
          hint={t('customers.phoneHint')}
          {...(error?.issueFor('phone') ? { error: error.issueFor('phone') } : {})}
        />

        {error && error.issues.length === 0 ? (
          <p
            className="rounded-[var(--radius-field)] bg-[var(--color-danger-soft)] px-3.5 py-3 text-sm text-[var(--color-danger)]"
            role="alert"
          >
            {error.message}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
