import { useState } from 'react';
import { PageBody, PageHeader, SectionHeading } from '@/components/layout/PageHeader';
import { Card, Skeleton, Tabs } from '@/components/ui';
import { PageTransition } from '@/components/motion';
import { Sparkline } from '@/components/charts/Sparkline';
import { useT, useI18n } from '@/app/providers/I18nProvider';
import { useQuery } from '@/hooks/useApi';
import { formatMoney, formatMoneyCompact } from '@/lib/format';
import type { Transaction } from '@shared/entities';

/**
 * Reports.
 *
 * Deliberately modest. A shopkeeper's real analytics question is answered by
 * Shop Pulse (what needs doing) and Shop Memory (what happened); this screen
 * covers the one thing neither does — the shape of sales over time.
 */

type SalesResponse = { transactions: Transaction[] };
type MarginResponse = {
  products: Array<{
    name: string;
    salesVelocity: number;
    marginPercent: number;
    dailyProfit: number;
  }>;
};

export default function ReportsPage() {
  const t = useT();
  const { locale } = useI18n();
  const [days, setDays] = useState<7 | 30>(30);

  const sales = useQuery<SalesResponse>('/transactions', { query: { limit: 200 } });
  const margins = useQuery<MarginResponse>('/ai/insight/margin');

  // Bucket by day so the chart has one point per day, including quiet days.
  const buckets = new Map<string, number>();
  const today = new Date();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(today.getTime() - offset * 86_400_000);
    buckets.set(date.toISOString().slice(0, 10), 0);
  }
  for (const transaction of sales.data?.transactions ?? []) {
    const key = transaction.timestamp.slice(0, 10);
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + transaction.total);
  }

  const series = [...buckets.entries()];
  const total = series.reduce((sum, [, value]) => sum + value, 0);
  const best = series.reduce(
    (max, entry) => (entry[1] > max[1] ? entry : max),
    ['', 0] as [string, number],
  );

  return (
    <PageTransition>
      <PageHeader title={t('nav.reports')} />

      <PageBody>
        <Tabs
          value={String(days) as '7' | '30'}
          onChange={(value) => setDays(Number(value) as 7 | 30)}
          options={[
            { value: '7', label: '7 days' },
            { value: '30', label: '30 days' },
          ]}
        />

        <Card className="mt-4 p-5">
          <p className="text-xs font-semibold tracking-wide text-[var(--color-muted)] uppercase">
            {t('sales.revenue')} · {days} days
          </p>
          <p className="mt-1 text-3xl font-extrabold text-[var(--color-ink)] tabular">
            {formatMoney(total)}
          </p>

          {sales.loading && !sales.data ? (
            <Skeleton className="mt-5 h-24" />
          ) : (
            <Sparkline
              values={series.map(([, value]) => value)}
              labels={series.map(([day]) =>
                new Date(`${day}T12:00:00Z`).toLocaleDateString(locale, {
                  day: 'numeric',
                  month: 'short',
                }),
              )}
              format={formatMoneyCompact}
              className="mt-5"
            />
          )}

          {best[1] > 0 ? (
            <p className="mt-3 text-xs text-[var(--color-muted)]">
              Best day:{' '}
              <span className="font-semibold text-[var(--color-ink)]">
                {new Date(`${best[0]}T12:00:00Z`).toLocaleDateString(locale, {
                  day: 'numeric',
                  month: 'short',
                })}
              </span>{' '}
              · {formatMoney(best[1])}
            </p>
          ) : null}
        </Card>

        {/* What each shelf earns per day — velocity times unit margin. */}
        <SectionHeading title="What earns the most" className="mt-7" />
        {margins.loading && !margins.data ? (
          <Skeleton className="h-48" />
        ) : (margins.data?.products.length ?? 0) === 0 ? (
          <Card className="p-5 text-center text-sm text-[var(--color-muted)]">
            Not enough sales yet to compare products.
          </Card>
        ) : (
          <Card className="divide-y divide-[var(--color-line)]">
            {margins.data!.products.slice(0, 10).map((product) => {
              const max = margins.data!.products[0]?.dailyProfit || 1;
              return (
                <div key={product.name} className="p-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <p className="min-w-0 truncate text-sm font-semibold text-[var(--color-ink)]">
                      {product.name}
                    </p>
                    <span className="shrink-0 text-sm font-bold text-[var(--color-success)] tabular">
                      {formatMoney(product.dailyProfit)}/day
                    </span>
                  </div>

                  <div className="mt-2 flex items-center gap-2">
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-sunken)]">
                      <span
                        className="block h-full rounded-full bg-[var(--color-success)]"
                        style={{ width: `${Math.max(2, (product.dailyProfit / max) * 100)}%` }}
                      />
                    </span>
                    <span className="w-24 shrink-0 text-right text-[11px] text-[var(--color-muted)] tabular">
                      {product.salesVelocity}/day · {product.marginPercent}%
                    </span>
                  </div>
                </div>
              );
            })}
          </Card>
        )}
      </PageBody>
    </PageTransition>
  );
}
