import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, Check, Package, Truck } from 'lucide-react';
import { PageBody, PageHeader } from '@/components/layout/PageHeader';
import {
  Button,
  EmptyState,
  Panel,
  Skeleton,
  StatusBadge,
  Tabs,
  type StatusTone,
} from '@/components/ui';
import { PageTransition } from '@/components/motion';
import { useT, useI18n } from '@/app/providers/I18nProvider';
import { useToast } from '@/app/providers/ToastProvider';
import { useQuery } from '@/hooks/useApi';
import { api, ApiError } from '@/lib/api';
import { formatMoney, formatQuantity, formatTimelineDate } from '@/lib/format';
import type { Order, OrderStatus } from '@shared/entities';

/**
 * Orders.
 *
 * Organised by status, because that is how the work actually moves: an order
 * is a thing in a queue, not a document. Each row shows only what is needed to
 * act — who, what, how much, what state — and the action that advances it.
 */

type OrdersResponse = {
  orders: Order[];
  totals: { count: number; readyCount: number; value: number };
};

const STATUS_TONE: Record<OrderStatus, StatusTone> = {
  placed: 'neutral',
  preparing: 'warning',
  ready: 'success',
  collected: 'info',
  cancelled: 'danger',
};

type Filter = 'active' | OrderStatus | 'all';

export default function OrdersPage() {
  const t = useT();
  const { locale } = useI18n();
  const toast = useToast();

  const [filter, setFilter] = useState<Filter>('active');
  const [busyId, setBusyId] = useState<string | null>(null);

  // 'all' and every explicit status need the full list; only 'active' can be
  // narrowed server-side.
  const { data, loading, error, refetch } = useQuery<OrdersResponse>('/orders', {
    query: { activeOnly: filter === 'active' },
  });

  const visible = useMemo(() => {
    const orders = data?.orders ?? [];
    if (filter === 'active' || filter === 'all') return orders;
    return orders.filter((order) => order.status === filter);
  }, [data, filter]);

  const counts = useMemo(() => {
    const orders = data?.orders ?? [];
    return {
      placed: orders.filter((order) => order.status === 'placed').length,
      preparing: orders.filter((order) => order.status === 'preparing').length,
      ready: orders.filter((order) => order.status === 'ready').length,
    };
  }, [data]);

  const setStatus = async (order: Order, status: OrderStatus) => {
    setBusyId(order.orderId);
    try {
      await api.patch(`/orders/${order.orderId}/status`, { status });
      void refetch();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : t('errors.generic'));
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Notifying a customer is a separate, explicit action — marking an order
   * ready does not message anyone. The toast repeats the server's answer, which
   * says whether the message was actually delivered.
   */
  const notify = async (order: Order) => {
    setBusyId(order.orderId);
    try {
      const result = await api.post<{ sent: boolean; message: string }>(
        '/agent/notify-order-ready',
        { orderId: order.orderId },
      );
      if (result.sent) toast.success(result.message);
      else toast.info(result.message);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : t('errors.generic'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <PageTransition>
      <PageHeader
        title={t('orders.title')}
        stats={
          data
            ? [
                { label: t('orders.activeLabel'), value: data.totals.count },
                {
                  label: t('orders.readyLabel'),
                  value: data.totals.readyCount,
                  tone: data.totals.readyCount > 0 ? 'warning' : 'default',
                },
                { label: t('orders.valueLabel'), value: formatMoney(data.totals.value) },
              ]
            : undefined
        }
      />

      <PageBody>
        <div className="overflow-x-auto no-scrollbar">
          <Tabs
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'active', label: t('orders.filterActive') },
              { value: 'placed', label: t('orders.placed'), count: counts.placed },
              { value: 'preparing', label: t('orders.preparing'), count: counts.preparing },
              { value: 'ready', label: t('orders.ready'), count: counts.ready },
              { value: 'all', label: t('common.all') },
            ]}
          />
        </div>

        <div className="mt-4">
          {loading && !data ? (
            <Panel inset className="space-y-3">
              {Array.from({ length: 5 }).map((_, index) => (
                <Skeleton key={index} className="h-12" />
              ))}
            </Panel>
          ) : error ? (
            <Panel inset className="text-center">
              <p className="text-sm text-[var(--color-muted)]">{error.message}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => void refetch()}>
                {t('common.retry')}
              </Button>
            </Panel>
          ) : visible.length === 0 ? (
            <Panel>
              <EmptyState
                icon={<Truck className="size-6" />}
                title={t('orders.empty')}
                body={t('orders.emptyBody')}
              />
            </Panel>
          ) : (
            <Panel className="divide-y divide-[var(--color-line)] px-4 sm:px-5">
              {visible.map((order) => (
                <div
                  key={order.orderId}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Link
                        to={`/app/customers/${order.customerId}`}
                        className="truncate text-sm font-semibold text-[var(--color-ink)] hover:underline"
                      >
                        {order.customerName}
                      </Link>
                      <StatusBadge tone={STATUS_TONE[order.status]}>
                        {t(`orders.${order.status}`)}
                      </StatusBadge>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-[var(--color-muted)]">
                      {order.items.length} {t('orders.itemsWord')} ·{' '}
                      {order.items
                        .map((item) => `${formatQuantity(item.quantity, item.unit)} ${item.name}`)
                        .join(', ')}
                    </p>
                  </div>

                  <div className="shrink-0 text-right">
                    <p className="text-sm font-bold text-[var(--color-ink)] tabular">
                      {formatMoney(order.total)}
                    </p>
                    <p className="text-xs text-[var(--color-faint)]">
                      {formatTimelineDate(order.createdAt, locale)}
                    </p>
                  </div>

                  {order.status !== 'collected' && order.status !== 'cancelled' ? (
                    <div className="flex w-full shrink-0 gap-2 sm:w-auto">
                      {order.status === 'ready' ? (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busyId === order.orderId}
                            onClick={() => void notify(order)}
                            icon={<Bell className="size-3.5" />}
                          >
                            {t('orders.notifyCustomer')}
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={busyId === order.orderId}
                            onClick={() => void setStatus(order, 'collected')}
                            icon={<Check className="size-3.5" />}
                          >
                            {t('orders.markCollected')}
                          </Button>
                        </>
                      ) : (
                        <>
                          {order.status === 'placed' ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busyId === order.orderId}
                              onClick={() => void setStatus(order, 'preparing')}
                            >
                              {t('orders.preparing')}
                            </Button>
                          ) : null}
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={busyId === order.orderId}
                            onClick={() => void setStatus(order, 'ready')}
                            icon={<Package className="size-3.5" />}
                          >
                            {t('orders.markReady')}
                          </Button>
                        </>
                      )}
                    </div>
                  ) : null}
                </div>
              ))}
            </Panel>
          )}
        </div>
      </PageBody>
    </PageTransition>
  );
}
