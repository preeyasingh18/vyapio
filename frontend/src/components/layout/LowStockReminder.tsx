import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PackagePlus, TriangleAlert, X } from 'lucide-react';
import { Button, IconButton } from '@/components/ui';
import { useT } from '@/app/providers/I18nProvider';
import { useQuery } from '@/hooks/useApi';
import { cn } from '@/lib/cn';

/**
 * What needs buying, shown when the shop is opened.
 *
 * Derived from the current quantity every time, never from a stored "seen"
 * flag. An alert you can mark as read is an alert that goes quiet while the
 * shelf is still empty — so this reappears on every open, and the only thing
 * that clears an item from it is putting stock back.
 *
 * Dismissing hides it for the rest of this session, which is the difference
 * between a reminder and a nag. Reopening the app brings it back if the stock
 * is still low.
 */

type Alert = {
  productId: string;
  name: string;
  unit: string;
  stock: number;
  lowStockAt: number;
  supplier: string;
  status: 'low_stock' | 'out_of_stock';
};

type AlertsResponse = {
  alerts: Alert[];
  counts: { lowStock: number; outOfStock: number };
  threshold: number;
};

export function LowStockReminder() {
  const t = useT();
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(false);

  const { data } = useQuery<AlertsResponse>('/inventory/alerts');
  const alerts = data?.alerts ?? [];

  if (dismissed || alerts.length === 0) return null;

  const outOfStock = alerts.filter((alert) => alert.status === 'out_of_stock');
  const anyOut = outOfStock.length > 0;

  /**
   * Opens the restock sheet for this exact product.
   *
   * The whole point of naming the item is that the shopkeeper does not then
   * have to go and find it again, so this carries the id rather than dropping
   * them on the stock list.
   */
  const restock = (alert: Alert) => navigate(`/app/inventory?restock=${alert.productId}`);

  return (
    <div
      className={cn(
        'mb-4 overflow-hidden rounded-[var(--radius-card)] border',
        anyOut
          ? 'border-[var(--color-danger)]/35 bg-[var(--color-danger-soft)]'
          : 'border-[var(--color-warning)]/35 bg-[var(--color-warning-soft)]',
      )}
      role="status"
    >
      <div className="flex items-center gap-2 px-4 pt-3">
        <TriangleAlert
          className={cn(
            'size-4 shrink-0',
            anyOut ? 'text-[var(--color-danger)]' : 'text-[var(--color-warning)]',
          )}
          aria-hidden="true"
        />
        <p
          className={cn(
            'text-[length:var(--text-eyebrow)] font-bold tracking-[0.08em] uppercase',
            anyOut ? 'text-[var(--color-danger)]' : 'text-[var(--color-warning)]',
          )}
        >
          {alerts.length === 1
            ? anyOut
              ? t('inventory.reminderOutTitle')
              : t('inventory.reminderLowTitle')
            : t('inventory.reminderTitleMany', { count: alerts.length })}
        </p>
        <IconButton
          size="sm"
          className="ml-auto"
          label={t('common.dismiss')}
          icon={<X className="size-4" />}
          onClick={() => setDismissed(true)}
        />
      </div>

      {/* Every item is named. "Inventory is low" tells nobody what to buy. */}
      <ul className="divide-y divide-[var(--color-line)]/60 px-4 pb-3">
        {alerts.map((alert) => (
          <li
            key={alert.productId}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold text-[var(--color-ink)]">{alert.name}</p>
              <p className="text-xs text-[var(--color-ink-soft)] tabular">
                {alert.status === 'out_of_stock'
                  ? t('inventory.reminderNoneLeft', { unit: alert.unit })
                  : t('inventory.reminderOnlyLeft', { count: alert.stock, unit: alert.unit })}
                {alert.supplier ? (
                  <span className="text-[var(--color-muted)]"> · {alert.supplier}</span>
                ) : null}
              </p>
            </div>

            <Button
              size="sm"
              variant="outline"
              icon={<PackagePlus className="size-4" />}
              onClick={() => restock(alert)}
            >
              {t('inventory.restockNamed', { name: alert.name })}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
