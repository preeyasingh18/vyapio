import { useMemo, useState } from 'react';
import { Plus, Receipt } from 'lucide-react';
import { PageBody, PageHeader } from '@/components/layout/PageHeader';
import {
  Button,
  EmptyState,
  Metric,
  Panel,
  SearchBar,
  Skeleton,
  Table,
  Tabs,
} from '@/components/ui';
import { PageTransition } from '@/components/motion';
import { useT, useI18n } from '@/app/providers/I18nProvider';
import { useQuery } from '@/hooks/useApi';
import {
  formatMoney,
  formatMoneyCompact,
  formatQuantity,
  formatTime,
  formatTimelineDate,
} from '@/lib/format';
import { SaleStatus } from '@/components/money/SaleStatus';
import type { SettledTransaction } from '@shared/entities';

/**
 * Sales.
 *
 * Three figures, a window, and the rows. Entering a sale is the only action,
 * so it gets the one solid button on the page.
 */

type SalesResponse = {
  transactions: SettledTransaction[];
  totals: { count: number; revenue: number; pending: number; collected: number };
};

type Days = '1' | '7' | '30';

/** Far-future bound for an open-ended range query. */
const MAX_ISO = '9999-12-31T23:59:59.999Z';

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/**
 * A money figure that survives three-across at 390px.
 *
 * `₹1,24,000` is nine glyphs; in a third of a phone's width it either
 * overflows the divider or forces the whole row to scroll. Below `sm` the
 * compact form is shown instead, and the exact rupee figure returns as soon
 * as there is room for it — precision is deferred, never discarded, and the
 * per-sale rows underneath always carry the full amount.
 */
function Money({ paise, pending }: { paise: number; pending: boolean }) {
  if (pending) return <>—</>;
  return (
    <>
      <span className="sm:hidden">{formatMoneyCompact(paise)}</span>
      <span className="hidden sm:inline">{formatMoney(paise)}</span>
    </>
  );
}

export default function SalesPage() {
  const t = useT();
  const { locale } = useI18n();
  const [search, setSearch] = useState('');

  /**
   * The window is filtered on the server.
   *
   * `from` is computed in the tab handler — an event, where reading the clock
   * is fine — rather than during render, where `Date.now()` would make the
   * component's output depend on when React happened to run it. It also means
   * only the rows being shown come over the wire.
   */
  const [range, setRange] = useState<{ days: Days; from: string }>(() => ({
    days: '7',
    from: isoDaysAgo(7),
  }));

  const { data, loading, error, refetch } = useQuery<SalesResponse>('/transactions', {
    query: { limit: 200, from: range.from, to: MAX_ISO },
  });

  const visible = useMemo(() => {
    const rows = data?.transactions ?? [];
    const needle = search.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (transaction) =>
        transaction.customerName.toLowerCase().includes(needle) ||
        transaction.items.some((item) => item.name.toLowerCase().includes(needle)),
    );
  }, [data, search]);

  const revenue = data?.totals.revenue ?? 0;
  const pending = data?.totals.pending ?? 0;

  return (
    <PageTransition>
      <PageHeader
        title={t('sales.title')}
        stats={data ? [{ label: t('home.salesWord'), value: data.totals.count }] : undefined}
        actions={
          <Button size="sm" to="/app/sales/new" icon={<Plus className="size-4" />}>
            <span className="hidden sm:inline">{t('sales.new')}</span>
          </Button>
        }
      />

      <PageBody>
        {/* Summary: divided, not three boxes. */}
        <Panel inset>
          <div className="grid grid-cols-3 divide-x divide-[var(--color-line)]">
            <Metric
              label={t('sales.revenue')}
              value={<Money paise={revenue} pending={loading && !data} />}
              size="md"
              className="pr-4"
            />
            <Metric
              label={t('sales.collected')}
              value={<Money paise={revenue - pending} pending={loading && !data} />}
              size="md"
              tone="success"
              className="px-4"
            />
            <Metric
              label={t('sales.outstanding')}
              value={<Money paise={pending} pending={loading && !data} />}
              size="md"
              tone={pending > 0 ? 'warning' : 'default'}
              className="pl-4"
            />
          </div>
        </Panel>

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <SearchBar
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onClear={() => setSearch('')}
            placeholder={t('sales.search')}
            aria-label={t('sales.search')}
            className="sm:max-w-xs"
          />

          <Tabs
            value={range.days}
            onChange={(next) => setRange({ days: next, from: isoDaysAgo(Number(next)) })}
            options={[
              { value: '1', label: t('common.today') },
              { value: '7', label: t('sales.days7') },
              { value: '30', label: t('sales.days30') },
            ]}
          />
        </div>

        <div className="mt-4">
          {loading && !data ? (
            <Panel inset className="space-y-3">
              {Array.from({ length: 6 }).map((_, index) => (
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
                getKey={(transaction) => transaction.transactionId}
                getHref={(transaction) => `/app/customers/${transaction.customerId}`}
                rowLabel={(transaction) => transaction.customerName || 'Walk-in'}
                empty={
                  <EmptyState
                    icon={<Receipt className="size-6" />}
                    title={search ? t('sales.noMatches') : t('sales.empty')}
                    body={search ? undefined : t('sales.emptyBody')}
                    action={
                      search ? null : (
                        <Button to="/app/sales/new" icon={<Plus className="size-4" />}>
                          {t('sales.new')}
                        </Button>
                      )
                    }
                  />
                }
                columns={[
                  {
                    key: 'customer',
                    header: t('customers.columnCustomer'),
                    cell: (transaction) => (
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-[var(--color-ink)]">
                          {transaction.customerName || t('home.walkIn')}
                        </p>
                        <p className="truncate text-xs text-[var(--color-muted)]">
                          {transaction.items
                            .map((item) => `${formatQuantity(item.quantity, item.unit)} ${item.name}`)
                            .join(', ')}
                        </p>
                      </div>
                    ),
                  },
                  {
                    key: 'when',
                    header: t('sales.columnWhen'),
                    hideBelow: 'lg',
                    width: '20%',
                    cell: (transaction) => (
                      <span className="text-xs text-[var(--color-muted)]">
                        {formatTimelineDate(transaction.timestamp, locale)} ·{' '}
                        {formatTime(transaction.timestamp, locale)}
                      </span>
                    ),
                  },
                  {
                    key: 'method',
                    header: t('sales.columnMethod'),
                    hideBelow: 'xl',
                    width: '12%',
                    cell: (transaction) => (
                      <span className="text-xs text-[var(--color-muted)] uppercase">
                        {transaction.paymentMethod}
                        {/* Voice and agent rows are labelled, always. */}
                        {transaction.source === 'voice' || transaction.source === 'agent'
                          ? ` · ${transaction.source}`
                          : ''}
                      </span>
                    ),
                  },
                  {
                    key: 'total',
                    header: t('sales.columnTotal'),
                    align: 'right',
                    width: '14%',
                    cell: (transaction) => (
                      <span className="font-semibold text-[var(--color-ink)] tabular">
                        {formatMoney(transaction.total)}
                      </span>
                    ),
                  },
                  {
                    key: 'status',
                    header: t('customers.columnStatus'),
                    align: 'right',
                    width: '16%',
                    cell: (transaction) => (
                      <SaleStatus
                        pending={transaction.pending}
                        paidAt={transaction.paidAt}
                        total={transaction.total}
                      />
                    ),
                  },
                ]}
                renderCard={(transaction) => (
                  <div className="flex items-start gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-[var(--color-ink)]">
                        {transaction.customerName || t('home.walkIn')}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-[var(--color-muted)]">
                        {transaction.items
                          .map((item) => `${formatQuantity(item.quantity, item.unit)} ${item.name}`)
                          .join(', ')}
                      </p>
                      <p className="mt-0.5 text-xs text-[var(--color-faint)]">
                        {formatTime(transaction.timestamp, locale)} ·{' '}
                        {transaction.paymentMethod.toUpperCase()}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-sm font-bold text-[var(--color-ink)] tabular">
                        {formatMoney(transaction.total)}
                      </p>
                      <SaleStatus
                        className="mt-0.5 block"
                        variant="plain"
                        pending={transaction.pending}
                        paidAt={transaction.paidAt}
                        total={transaction.total}
                      />
                    </div>
                  </div>
                )}
              />
            </Panel>
          )}
        </div>
      </PageBody>
    </PageTransition>
  );
}
