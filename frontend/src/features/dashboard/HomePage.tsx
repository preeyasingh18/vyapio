import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Bell,
  Boxes,
  CircleCheck,
  IndianRupee,
  Mic,
  Package,
  Plus,
  ScanLine,
  Sparkles,
  TrendingUp,
  Truck,
  Users,
  Wallet,
} from 'lucide-react';
import {
  Button,
  Panel,
  QuickAction,
  SectionHeader,
  SeeAll,
  Skeleton,
  type StatusTone,
} from '@/components/ui';
import { AttentionRow, ActivityItem } from '@/components/ui';
import { MiniBars, type BarPoint } from '@/components/charts/MiniBars';
import { Counter, PageTransition } from '@/components/motion';
import { LowStockReminder } from '@/components/layout/LowStockReminder';
import { MoreMenu } from '@/components/layout/MoreMenu';
import { useT, useI18n } from '@/app/providers/I18nProvider';
import { useAuth } from '@/app/providers/AuthProvider';
import { useQuery } from '@/hooks/useApi';
import { formatMoney, formatMoneyCompact, formatNumber, initials } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { PulseCard, ShopPulse } from '@shared/ai';
import type { SettledTransaction } from '@shared/entities';

/**
 * The home screen.
 *
 * Answers four questions in order, and nothing else: how is today going, what
 * needs a decision, what can I start now, what just happened. Each is a band,
 * not a card — the page reads top to bottom rather than as a grid to scan.
 *
 * Every figure here comes from a real endpoint. There is no placeholder data
 * on this screen: a dashboard that invents a trend is worse than one that
 * admits it has none.
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

type TransactionsResponse = { transactions: SettledTransaction[] };

export default function HomePage() {
  const t = useT();
  const { locale } = useI18n();
  const { vendor } = useAuth();

  const pulse = useQuery<PulseResponse>('/ai/pulse');
  const week = useQuery<SummaryResponse>('/transactions/summary', { query: { days: 7 } });
  const recent = useQuery<TransactionsResponse>('/transactions', { query: { limit: 6 } });

  const data = pulse.data;
  const loadingHero = pulse.loading && !data;

  const now = new Date();
  const hour = now.getHours();
  const greeting =
    hour < 12
      ? t('home.greetingMorning')
      : hour < 17
        ? t('home.greetingAfternoon')
        : t('home.greetingEvening');

  const dateLine = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(now);

  /* ── Week trend ──────────────────────────────────────────────────────── */

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
   * Today against yesterday.
   *
   * Only shown when yesterday actually had takings — "up 100%" against a zero
   * baseline is arithmetic, not information.
   */
  const delta = useMemo(() => {
    const series = week.data?.series;
    if (!series || series.length < 2) return undefined;
    const today = series[series.length - 1]?.revenue ?? 0;
    const yesterday = series[series.length - 2]?.revenue ?? 0;
    if (yesterday <= 0) return undefined;

    const change = ((today - yesterday) / yesterday) * 100;
    const rounded = Math.abs(change) < 0.1 ? 0 : change;
    return {
      direction: rounded > 0 ? ('up' as const) : rounded < 0 ? ('down' as const) : ('flat' as const),
      text: `${rounded > 0 ? '↑' : rounded < 0 ? '↓' : '→'} ${Math.abs(rounded).toFixed(1)}% ${t('home.vsYesterday')}`,
    };
  }, [week.data, t]);

  const attention = (data?.pulse.cards ?? []).filter(
    (card) => card.severity !== 'positive',
  );

  return (
    <PageTransition>
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header className="border-b border-[var(--color-line)] bg-[var(--color-surface)]">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-bold tracking-tight text-[var(--color-ink)] sm:text-xl">
              {greeting}, {vendor?.shopName ?? t('brand.name')}
            </h1>
            <p className="mt-0.5 truncate text-xs text-[var(--color-muted)]">
              {vendor?.city ? `${vendor.city} · ` : ''}
              {dateLine}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <MoreMenu />
            {vendor ? (
              <Link
                to="/app/settings"
                className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-ink)] text-[11px] font-bold text-[var(--color-bg)] transition-opacity hover:opacity-85"
                aria-label={t('nav.settings')}
              >
                {initials(vendor.shopName)}
              </Link>
            ) : null}
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6 sm:py-6">
        {/*
          What needs buying, above everything else. This is the screen the shop
          is opened on, and stock that has run out is the one thing a shopkeeper
          cannot fix later in the day.
        */}
        <LowStockReminder />

        {/* ── Today ─────────────────────────────────────────────────────── */}
        <section>
          <SectionHeader title={t('home.today')} />

          {/*
            Four tinted cards rather than one number and three footnotes.

            The tint is the grouping: a shopkeeper looking for "how much is
            owed" finds the peach card without reading a label, and the same
            colour means the same thing on every screen. Ink stays common to
            all four — four differently-coloured figures would read as
            decoration and slow the numbers down.
          */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <TintCard
              tint="lavender"
              label={t('home.todaysSales')}
              icon={<IndianRupee className="size-4" aria-hidden="true" />}
              loading={loadingHero}
              value={
                <Counter value={data?.today.revenue ?? 0} format={(value) => formatMoney(value)} />
              }
              support={
                data ? (
                  <span className="flex flex-wrap items-center gap-x-2">
                    <span className="tabular">
                      {data.today.saleCount} {t('home.salesWord')}
                    </span>
                    {delta ? (
                      <span
                        className={cn(
                          'font-semibold tabular',
                          delta.direction === 'up'
                            ? 'text-[var(--color-success)]'
                            : delta.direction === 'down'
                              ? 'text-[var(--color-danger)]'
                              : '',
                        )}
                      >
                        {delta.text}
                      </span>
                    ) : null}
                    {data.today.estimatedProfit > 0 ? (
                      <span className="flex items-center gap-1 text-[var(--color-success)]">
                        <TrendingUp className="size-3" aria-hidden="true" />
                        <span className="font-semibold tabular">
                          {formatMoney(data.today.estimatedProfit)}
                        </span>
                      </span>
                    ) : null}
                  </span>
                ) : null
              }
            />

            <TintCard
              tint="peach"
              label={t('home.pending')}
              icon={<Wallet className="size-4" aria-hidden="true" />}
              loading={loadingHero}
              value={data ? formatMoneyCompact(data.today.pending) : '—'}
              support={t('home.pendingSupport')}
            />

            <TintCard
              tint="mint"
              label={t('home.customers')}
              icon={<Users className="size-4" aria-hidden="true" />}
              loading={loadingHero}
              value={data ? formatNumber(data.today.totalCustomers, locale) : '—'}
              support={t('home.customersSupport')}
            />

            <TintCard
              tint="butter"
              label={t('home.needsAttention')}
              icon={<Bell className="size-4" aria-hidden="true" />}
              loading={loadingHero}
              value={data ? String(attention.length) : '—'}
              support={t('home.attentionSupport')}
            />
          </div>
        </section>

        {/* ── Quick actions ─────────────────────────────────────────────── */}
        <section className="mt-7">
          <SectionHeader title={t('home.quickActions')} />
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            <QuickAction
              to="/app/scan"
              icon={<ScanLine className="size-[18px]" aria-hidden="true" />}
              label={t('home.scanCustomer')}
              emphasis="primary"
            />
            <QuickAction
              to="/app/sales/new"
              icon={<Plus className="size-[18px]" aria-hidden="true" />}
              label={t('home.addSale')}
            />
            <QuickAction
              to="/app/orders"
              icon={<Truck className="size-[18px]" aria-hidden="true" />}
              label={t('home.newOrder')}
            />
            <QuickAction
              to="/app/voice"
              icon={<Mic className="size-[18px]" aria-hidden="true" />}
              label={t('home.speak')}
            />
          </div>
        </section>

        {/* ── Attention ─────────────────────────────────────────────────── */}
        <section className="mt-7">
          <SectionHeader
            title={t('home.needsAttention')}
            action={attention.length > 0 ? <SeeAll to="/app/pulse" label={t('common.viewAll')} /> : undefined}
          />

          {pulse.loading && !data ? (
            <Panel className="divide-y divide-[var(--color-line)] px-4">
              <div className="py-3.5">
                <Skeleton className="h-9" />
              </div>
              <div className="py-3.5">
                <Skeleton className="h-9" />
              </div>
            </Panel>
          ) : pulse.error ? (
            <Panel inset>
              <p className="text-sm text-[var(--color-muted)]">{pulse.error.message}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => void pulse.refetch()}>
                {t('common.retry')}
              </Button>
            </Panel>
          ) : attention.length > 0 ? (
            <Panel className="divide-y divide-[var(--color-line)] px-4">
              {attention.slice(0, 4).map((card) => (
                <AttentionRow
                  key={card.id}
                  tone={severityTone(card.severity)}
                  icon={kindIcon(card.kind)}
                  title={card.title}
                  detail={card.narration || card.body || undefined}
                  action={
                    card.actionHref ? (
                      <Button to={card.actionHref} variant="outline" size="sm">
                        {card.actionLabel ?? t('common.view')}
                      </Button>
                    ) : undefined
                  }
                />
              ))}
            </Panel>
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

        {/* ── Trend + activity ──────────────────────────────────────────── */}
        <div className="mt-7 grid gap-6 lg:grid-cols-[1.25fr_1fr]">
          <section>
            <SectionHeader
              title={t('home.salesOverview')}
              action={<SeeAll to="/app/reports" label={t('home.viewReport')} />}
            />
            <Panel inset>
              {week.loading && !week.data ? (
                <Skeleton className="h-[110px]" />
              ) : bars.length > 0 ? (
                <>
                  <div className="mb-3 flex items-baseline gap-2">
                    <span className="text-xl font-extrabold tracking-tight text-[var(--color-ink)] tabular">
                      {formatMoneyCompact(week.data?.revenue ?? 0)}
                    </span>
                    <span className="text-xs text-[var(--color-muted)]">
                      {t('home.last7Days')} · {week.data?.saleCount ?? 0} {t('home.salesWord')}
                    </span>
                  </div>
                  <MiniBars points={bars} format={(value) => formatMoney(value)} />
                </>
              ) : (
                <p className="py-8 text-center text-sm text-[var(--color-muted)]">
                  {t('home.noTrendYet')}
                </p>
              )}
            </Panel>
          </section>

          <section>
            <SectionHeader
              title={t('home.recentActivity')}
              action={<SeeAll to="/app/sales" label={t('common.viewAll')} />}
            />
            <Panel inset>
              {recent.loading && !recent.data ? (
                <div className="space-y-3">
                  <Skeleton className="h-8" />
                  <Skeleton className="h-8" />
                  <Skeleton className="h-8" />
                </div>
              ) : recent.data && recent.data.transactions.length > 0 ? (
                <ul>
                  {recent.data.transactions.slice(0, 5).map((transaction, index, list) => (
                    <ActivityItem
                      key={transaction.transactionId}
                      title={transaction.customerName || t('home.walkIn')}
                      detail={`${t('home.purchased')} ${formatMoney(transaction.total)}${
                        transaction.pending > 0
                          ? ` · ${formatMoney(transaction.pending)} ${t('home.pendingWord')}`
                          : ''
                      }`}
                      time={relativeTime(transaction.timestamp, locale)}
                      tone={transaction.pending > 0 ? 'warning' : 'success'}
                      last={index === Math.min(list.length, 5) - 1}
                    />
                  ))}
                </ul>
              ) : (
                <p className="py-8 text-center text-sm text-[var(--color-muted)]">
                  {t('home.noActivityYet')}
                </p>
              )}
            </Panel>
          </section>
        </div>

        {/* Says plainly where the numbers came from. */}
        {data ? (
          <p className="mt-6 flex items-center justify-center gap-1.5 text-xs text-[var(--color-faint)]">
            <Sparkles className="size-3" aria-hidden="true" />
            {t('pulse.generatedBy')}
            {data.pulse.engine === 'bedrock' ? ` · ${t('pulse.narratedBy')}` : ''}
          </p>
        ) : null}
      </div>
    </PageTransition>
  );
}

/* ------------------------------------------------------------------ Parts */

/**
 * One figure on a tinted ground.
 *
 * The tint carries the meaning, so the value and its label stay in the common
 * ink: the card is doing the colour-coding and the text does not need to
 * repeat it. `support` is the one line of context underneath — what the number
 * is made of, not a second number.
 */
function TintCard({
  tint,
  label,
  icon,
  value,
  support,
  loading,
}: {
  tint: 'lavender' | 'peach' | 'mint' | 'butter';
  label: string;
  icon: ReactNode;
  value: ReactNode;
  support?: ReactNode;
  loading: boolean;
}) {
  return (
    <div
      className="rounded-[var(--radius-card)] px-4 py-3.5"
      style={{ backgroundColor: `var(--color-${tint})` }}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="truncate text-[length:var(--text-eyebrow)] font-semibold tracking-[0.08em] text-[var(--color-ink-soft)] uppercase">
          {label}
        </p>
        <span className="shrink-0 text-[var(--color-ink-soft)] opacity-55">{icon}</span>
      </div>

      {loading ? (
        <Skeleton className="mt-2.5 h-8 w-24" />
      ) : (
        <p className="mt-1.5 text-[length:var(--text-metric)] leading-none font-bold tracking-tight text-[var(--color-ink)] tabular">
          {value}
        </p>
      )}

      {support ? (
        <p className="mt-2 truncate text-xs text-[var(--color-ink-soft)] opacity-75">{support}</p>
      ) : null}
    </div>
  );
}

function severityTone(severity: PulseCard['severity']): StatusTone {
  if (severity === 'critical') return 'danger';
  if (severity === 'warning') return 'warning';
  if (severity === 'positive') return 'success';
  return 'info';
}

function kindIcon(kind: PulseCard['kind']) {
  const className = 'size-[16px]';
  switch (kind) {
    case 'stock':
      return <Boxes className={className} aria-hidden="true" />;
    case 'payments':
      return <Wallet className={className} aria-hidden="true" />;
    case 'orders':
      return <Package className={className} aria-hidden="true" />;
    case 'opportunity':
      return <TrendingUp className={className} aria-hidden="true" />;
    default:
      return <AlertTriangle className={className} aria-hidden="true" />;
  }
}

/** Short relative time — "2 min", "3 h", then a date. */
function relativeTime(iso: string, locale: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(new Date(iso));
}
