import { useParams } from 'react-router-dom';
import { Package, Receipt } from 'lucide-react';
import { PageBody, PageHeader, SectionHeading } from '@/components/layout/PageHeader';
import { Badge, Button, Card, EmptyState, Skeleton } from '@/components/ui';
import { PageTransition, Stagger, StaggerItem } from '@/components/motion';
import { useT, useI18n } from '@/app/providers/I18nProvider';
import { useQuery } from '@/hooks/useApi';
import { formatMoney, formatQuantity, formatTime, formatTimelineDate } from '@/lib/format';
import type { Commitment, Order, Payment, SettledTransaction } from '@shared/entities';

/**
 * One shop, from the customer's side.
 *
 * Receipts rendered as receipts — itemised, with what was paid and what is
 * still owed — because that is the artefact a customer actually wants when
 * they are checking a shopkeeper's arithmetic.
 */

type ShopResponse = {
  shop: { vendorId: string; shopName: string; category: string; city: string };
  profile: {
    customerId: string;
    name: string;
    outstanding: number;
    totalSpent: number;
    transactionCount: number;
  };
  transactions: SettledTransaction[];
  payments: Payment[];
  commitments: Commitment[];
  orders: Order[];
};

export default function CustomerShopPage() {
  const t = useT();
  const { locale } = useI18n();
  const { vendorId, customerId } = useParams<{ vendorId: string; customerId: string }>();

  const { data, loading, error, refetch } = useQuery<ShopResponse>(
    vendorId && customerId ? `/me/shops/${vendorId}/${customerId}` : null,
  );

  if (loading && !data) {
    return (
      <PageTransition className="min-h-dvh bg-[var(--color-bg)]">
        <PageHeader title={t('common.loading')} back="/me" />
        <PageBody>
          <Skeleton className="h-32" />
          <Skeleton className="mt-3 h-24" />
        </PageBody>
      </PageTransition>
    );
  }

  if (error || !data) {
    return (
      <PageTransition className="min-h-dvh bg-[var(--color-bg)]">
        <PageHeader title={t('errors.notFound')} back="/me" />
        <PageBody>
          <EmptyState
            title={error?.message ?? t('errors.notFound')}
            action={
              <Button variant="outline" onClick={() => void refetch()}>
                {t('common.retry')}
              </Button>
            }
          />
        </PageBody>
      </PageTransition>
    );
  }

  const readyOrders = data.orders.filter((order) => order.status === 'ready');

  return (
    <PageTransition className="min-h-dvh bg-[var(--color-bg)]">
      <PageHeader title={data.shop.shopName} subtitle={data.shop.city} back="/me" />

      <PageBody>
        <Card className="p-5">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-xs font-semibold tracking-wide text-[var(--color-muted)] uppercase">
                {t('customerApp.pending')}
              </p>
              <p
                className={`mt-1 text-3xl font-extrabold tabular ${
                  data.profile.outstanding > 0
                    ? 'text-[var(--color-warning)]'
                    : 'text-[var(--color-success)]'
                }`}
              >
                {formatMoney(Math.max(0, data.profile.outstanding))}
              </p>
            </div>

            <div className="text-right">
              <p className="text-sm font-semibold text-[var(--color-ink)] tabular">
                {formatMoney(data.profile.totalSpent)}
              </p>
              <p className="text-xs text-[var(--color-muted)]">
                over {data.profile.transactionCount} purchases
              </p>
            </div>
          </div>
        </Card>

        {readyOrders.length > 0 ? (
          <Card className="mt-3 border-[var(--color-success)] bg-[var(--color-success-soft)] p-4">
            <p className="flex items-center gap-2 text-sm font-bold text-[var(--color-success)]">
              <Package className="size-4" aria-hidden="true" />
              {readyOrders.length}{' '}
              {readyOrders.length === 1
                ? t('customerApp.orderReady')
                : t('customerApp.ordersReady')}
            </p>
            <ul className="mt-2 space-y-1">
              {readyOrders.map((order) => (
                <li key={order.orderId} className="text-xs text-[var(--color-ink-soft)]">
                  {order.items.map((item) => item.name).join(', ')} · {formatMoney(order.total)}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        <SectionHeading title={t('customerApp.transactions')} className="mt-7" />

        {data.transactions.length === 0 ? (
          <EmptyState
            icon={<Receipt className="size-6" />}
            title="No purchases yet"
            body="Your receipts from this shop will appear here."
          />
        ) : (
          <Stagger className="space-y-2.5">
            {data.transactions.map((transaction) => (
              <StaggerItem key={transaction.transactionId}>
                <ReceiptCard transaction={transaction} locale={locale} shopName={data.shop.shopName} />
              </StaggerItem>
            ))}
          </Stagger>
        )}
      </PageBody>
    </PageTransition>
  );
}

/** A receipt, styled as one — perforated top edge and all. */
function ReceiptCard({
  transaction,
  locale,
  shopName,
}: {
  transaction: SettledTransaction;
  locale: string;
  shopName: string;
}) {
  const t = useT();

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-dashed border-[var(--color-line-strong)] px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-xs font-bold tracking-wide text-[var(--color-muted)] uppercase">
            {shopName}
          </p>
          <p className="text-[11px] text-[var(--color-faint)]">
            {formatTimelineDate(transaction.timestamp, locale)} ·{' '}
            {formatTime(transaction.timestamp, locale)}
          </p>
        </div>
        {/* The live balance, not the frozen one: a customer shown a bill they
            have already cleared is the same lie from the other side. */}
        <span className="shrink-0 text-right">
          {transaction.pending > 0 ? (
            <Badge tone="warning" size="sm">
              {formatMoney(transaction.pending)} {t('common.pending').toLowerCase()}
            </Badge>
          ) : (
            <Badge tone="success" size="sm">
              {t('common.paid')}
            </Badge>
          )}
          {transaction.paidAt ? (
            <span className="mt-0.5 block text-[11px] whitespace-nowrap text-[var(--color-faint)]">
              {formatTimelineDate(transaction.paidAt, locale)} ·{' '}
              {formatTime(transaction.paidAt, locale)}
            </span>
          ) : null}
        </span>
      </div>

      <ul className="divide-y divide-[var(--color-line)]">
        {transaction.items.map((item, index) => (
          <li key={index} className="flex items-baseline justify-between gap-3 px-4 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-[var(--color-ink)]">{item.name}</span>
              <span className="text-xs text-[var(--color-muted)] tabular">
                {formatQuantity(item.quantity, item.unit)} × {formatMoney(item.unitPrice)}
              </span>
            </span>
            <span className="shrink-0 text-sm font-semibold text-[var(--color-ink)] tabular">
              {formatMoney(item.lineTotal)}
            </span>
          </li>
        ))}
      </ul>

      <div className="space-y-1 bg-[var(--color-sunken)] px-4 py-3">
        <Line label={t('common.total')} value={formatMoney(transaction.total)} bold />
        <Line
          label={`${t('common.paid')} · ${transaction.paymentMethod.toUpperCase()}`}
          value={formatMoney(transaction.paid)}
        />
        {transaction.pending > 0 ? (
          <Line
            label={t('common.pending')}
            value={formatMoney(transaction.pending)}
            tone="warning"
          />
        ) : transaction.outstanding > 0 && transaction.paidAt ? (
          /* Owed on the day, cleared since — the customer should see when. */
          <Line
            label={`${t('common.paidOn')} · ${formatTimelineDate(transaction.paidAt, locale)}`}
            value={formatMoney(transaction.outstanding)}
          />
        ) : null}
      </div>
    </Card>
  );
}

function Line({
  label,
  value,
  bold,
  tone,
}: {
  label: string;
  value: string;
  bold?: boolean;
  tone?: 'warning';
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-[var(--color-muted)]">{label}</span>
      <span
        className={`tabular ${bold ? 'text-base font-extrabold' : 'text-xs font-semibold'} ${
          tone === 'warning' ? 'text-[var(--color-warning)]' : 'text-[var(--color-ink)]'
        }`}
      >
        {value}
      </span>
    </div>
  );
}
