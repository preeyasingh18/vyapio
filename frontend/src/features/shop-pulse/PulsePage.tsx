import { useMemo } from 'react';
import { CircleCheck } from 'lucide-react';
import { PageBody, PageHeader } from '@/components/layout/PageHeader';
import {
  Button,
  Metric,
  Panel,
  SectionHeader,
  SeeAll,
  Skeleton,
} from '@/components/ui';
import { MiniBars, type BarPoint } from '@/components/charts/MiniBars';
import { PageTransition, Stagger, StaggerItem } from '@/components/motion';
import { PulseCardView } from './PulseCardView';
import { useT, useI18n } from '@/app/providers/I18nProvider';
import { useQuery } from '@/hooks/useApi';
import { formatMoney, formatMoneyCompact } from '@/lib/format';
import type { ShopPulse } from '@shared/ai';

/**
 * Shop Pulse.
 *
 * Business intelligence for one shop, which means a small number of questions
 * answered properly rather than a wall of charts. Three bands: how the week
 * moved, what the day holds, and what to do about it.
 *
 * Nothing here is decorative. The trend is real daily totals; the cards are
 * computed deterministically on the server and merely narrated by a model.
 */

type PulseResponse = {
  pulse: ShopPulse;
  today: {
    revenue: number;
    estimatedProfit: number;
    saleCount: number;
    customerCount: number;
    pending: number;
    totalCustomers: number;
  };
};

type SummaryResponse = {
  days: number;
  revenue: number;
  saleCount: number;
  series: Array<{ date: string; revenue: number; saleCount: number }>;
};

export default function PulsePage() {
  const t = useT();
  const { locale } = useI18n();
  const { data, loading, error, refetch } = useQuery<PulseResponse>('/ai/pulse');
  const week = useQuery<SummaryResponse>('/transactions/summary', { query: { days: 7 } });

  const bars = useMemo<BarPoint[]>(() => {
    const series = week.data?.series ?? [];
    return series.map((point, index) => ({
      label: new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(
        new Date(`${point.date}T12:00:00`),
      ),
      value: point.revenue,
      emphasis: index === series.length - 1,
    }));
  }, [week.data, locale]);

  /**
   * The busiest day of the week just gone.
   *
   * Stated only when there is a clear winner — calling a day "busiest" when
   * two are within a rupee of each other is a pattern the data does not
   * support.
   */
  const busiest = useMemo(() => {
    const series = week.data?.series ?? [];
    if (series.length < 3) return null;

    const sorted = [...series].sort((a, b) => b.revenue - a.revenue);
    const top = sorted[0];
    const next = sorted[1];
    if (!top || !next || top.revenue === 0) return null;
    if (top.revenue < next.revenue * 1.15) return null;

    return {
      day: new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(
        new Date(`${top.date}T12:00:00`),
      ),
      revenue: top.revenue,
    };
  }, [week.data, locale]);

  return (
    <PageTransition>
      <PageHeader title={t('pulse.title')} subtitle={t('pulse.subtitle')} />

      <PageBody>
        {/* ── The week ──────────────────────────────────────────────────── */}
        <section>
          <SectionHeader
            title={t('pulse.thisWeek')}
            action={<SeeAll to="/app/reports" label={t('home.viewReport')} />}
          />
          <Panel inset>
            {week.loading && !week.data ? (
              <Skeleton className="h-[120px]" />
            ) : bars.length > 0 ? (
              <>
                <div className="grid gap-5 sm:grid-cols-[auto_1fr] sm:items-end sm:gap-8">
                  <div className="grid grid-cols-3 divide-x divide-[var(--color-line)] sm:flex sm:divide-x-0">
                    <Metric
                      label={t('pulse.weekRevenue')}
                      value={formatMoneyCompact(week.data?.revenue ?? 0)}
                      size="lg"
                      className="pr-4 sm:pr-8"
                    />
                    <Metric
                      label={t('home.salesWord')}
                      value={String(week.data?.saleCount ?? 0)}
                      size="md"
                      className="px-4 sm:px-0 sm:pr-8"
                    />
                    <Metric
                      label={t('home.pending')}
                      value={data ? formatMoneyCompact(data.today.pending) : '—'}
                      size="md"
                      tone={data && data.today.pending > 0 ? 'warning' : 'default'}
                      className="pl-4 sm:pl-0"
                    />
                  </div>

                  <MiniBars points={bars} format={(value) => formatMoney(value)} height={80} />
                </div>

                {busiest ? (
                  <p className="mt-3 border-t border-[var(--color-line)] pt-3 text-sm text-[var(--color-muted)]">
                    {t('pulse.busiestDay', {
                      day: busiest.day,
                      amount: formatMoney(busiest.revenue),
                    })}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="py-8 text-center text-sm text-[var(--color-muted)]">
                {t('home.noTrendYet')}
              </p>
            )}
          </Panel>
        </section>

        {/* ── Today ─────────────────────────────────────────────────────── */}
        {data ? (
          <section className="mt-6">
            <SectionHeader title={t('home.today')} />
            <Panel inset>
              <div className="grid grid-cols-2 divide-x divide-y divide-[var(--color-line)] sm:grid-cols-4 sm:divide-y-0">
                <Metric
                  label={t('home.todaysSales')}
                  value={formatMoney(data.today.revenue)}
                  className="pr-4 pb-3 sm:pb-0"
                />
                <Metric
                  label={t('home.estimatedProfit')}
                  value={formatMoney(data.today.estimatedProfit)}
                  tone="success"
                  className="px-4 pb-3 sm:pb-0"
                />
                <Metric
                  label={t('home.salesWord')}
                  value={String(data.today.saleCount)}
                  className="pt-3 pr-4 sm:pt-0 sm:px-4"
                />
                <Metric
                  label={t('home.customersWord')}
                  value={String(data.today.customerCount)}
                  className="px-4 pt-3 sm:pt-0 sm:pl-4 sm:pr-0"
                />
              </div>
            </Panel>
          </section>
        ) : null}

        {/* ── What to do ────────────────────────────────────────────────── */}
        <section className="mt-6">
          <SectionHeader title={t('home.needsAttention')} />

          {loading && !data ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, index) => (
                <Skeleton key={index} className="h-24" />
              ))}
            </div>
          ) : error ? (
            <Panel inset className="text-center">
              <p className="text-sm text-[var(--color-muted)]">{error.message}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => void refetch()}>
                {t('common.retry')}
              </Button>
            </Panel>
          ) : data && data.pulse.cards.length > 0 ? (
            <Stagger className="space-y-2.5">
              {data.pulse.cards.map((card) => (
                <StaggerItem key={card.id}>
                  <PulseCardView card={card} />
                </StaggerItem>
              ))}
            </Stagger>
          ) : (
            <Panel className="flex items-center gap-3 px-4 py-5">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-success-soft)] text-[var(--color-success)]">
                <CircleCheck className="size-[18px]" aria-hidden="true" />
              </span>
              <div>
                <p className="text-sm font-semibold text-[var(--color-ink)]">
                  {t('home.prioritiesEmpty')}
                </p>
                <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                  {t('home.prioritiesEmptyBody')}
                </p>
              </div>
            </Panel>
          )}
        </section>

        {data ? (
          <p className="mt-6 text-center text-xs text-[var(--color-faint)]">
            {t('pulse.generatedBy')}
            {data.pulse.engine === 'bedrock' ? ` · ${t('pulse.narratedBy')}` : ''}
          </p>
        ) : null}
      </PageBody>
    </PageTransition>
  );
}
