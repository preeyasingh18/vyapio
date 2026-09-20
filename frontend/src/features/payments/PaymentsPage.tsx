import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CircleAlert, CircleCheck, Wallet } from 'lucide-react';
import { PageBody, PageHeader } from '@/components/layout/PageHeader';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Metric,
  Panel,
  Skeleton,
  StatusBadge,
  Tabs,
} from '@/components/ui';
import { PageTransition, Stagger, StaggerItem } from '@/components/motion';
import { useT, useI18n } from '@/app/providers/I18nProvider';
import { useQuery } from '@/hooks/useApi';
import { formatMoney, formatTimelineDate } from '@/lib/format';
import type { Commitment, Notification, Payment } from '@shared/entities';

/**
 * Payments.
 *
 * Two views: money owed (the collections list) and money received. The
 * reminder log is here too, and it is explicit about which reminders were
 * genuinely delivered — `not_delivered` is rendered as its own state, never
 * folded into "sent".
 */

type KhataResponse = {
  commitments: Array<Commitment & { remaining: number; daysOverdue: number; isOverdue: boolean }>;
  totals: {
    count: number;
    outstanding: number;
    overdue: number;
    overdueCount: number;
    customerCount: number;
  };
};

type PaymentsResponse = {
  payments: Payment[];
  totals: { count: number; collected: number; byMethod: Record<string, number> };
};

type RemindersResponse = {
  reminders: Notification[];
  /**
   * Safe status only — the backend never returns credentials. See
   * `describeProvider` in backend/src/services/notifications.ts.
   */
  provider: {
    name: string;
    channel: string;
    configured: boolean;
    canDeliver: boolean;
    status: 'connected' | 'not_configured' | 'incomplete';
    template?: string;
    templateLanguage?: string;
    requiresOptIn: boolean;
    note: string;
  };
  totals: { count: number; delivered: number; notDelivered: number; failed: number };
};

export default function PaymentsPage() {
  const t = useT();
  const { locale } = useI18n();
  const [tab, setTab] = useState<'owed' | 'received' | 'reminders'>('owed');

  const khata = useQuery<KhataResponse>('/khata');
  const payments = useQuery<PaymentsResponse>('/payments', { query: { days: 30 } });
  const reminders = useQuery<RemindersResponse>('/payments/reminders');
  /**
   * The live check, which also asks Meta whether the template is approved.
   *
   * The reminder list carries a provider block too, but that one only knows
   * what is in the environment — and credentials being set is not the same as
   * messages getting through. This is the one the banner believes.
   */
  const messaging = useQuery<RemindersResponse['provider']>('/payments/whatsapp/status');

  return (
    <PageTransition>
      <PageHeader
        title={t('payments.title')}
        stats={
          khata.data
            ? [
                { label: t('customers.countLabel'), value: khata.data.totals.customerCount },
                {
                  label: t('payments.overdue').toLowerCase(),
                  value: khata.data.totals.overdueCount,
                  tone: khata.data.totals.overdueCount > 0 ? 'danger' : 'default',
                },
              ]
            : undefined
        }
      />

      <PageBody>
        {/* Two figures that belong together: what is owed, and how much of it
            is already late. Divided rather than boxed — they are one reading. */}
        <Panel inset>
          <div className="flex items-start justify-between gap-4">
            <div className="grid flex-1 grid-cols-2 divide-x divide-[var(--color-line)]">
              <Metric
                label={t('payments.outstanding')}
                value={formatMoney(khata.data?.totals.outstanding ?? 0)}
                size="lg"
                tone="warning"
                support={`${khata.data?.totals.customerCount ?? 0} ${t('customers.countLabel')}`}
                className="pr-4"
              />
              <Metric
                label={t('payments.overdue')}
                value={formatMoney(khata.data?.totals.overdue ?? 0)}
                size="lg"
                tone={(khata.data?.totals.overdue ?? 0) > 0 ? 'danger' : 'default'}
                support={`${khata.data?.totals.overdueCount ?? 0} ${t('payments.pastDue')}`}
                className="pl-4"
              />
            </div>

            {/* The one-tap route into the agent's headline flow. */}
            {(khata.data?.totals.overdueCount ?? 0) > 0 ? (
              <Button to="/app/assistant" variant="outline" size="sm" className="hidden sm:flex">
                {t('payments.askToRemind')}
              </Button>
            ) : null}
          </div>

          {(khata.data?.totals.overdueCount ?? 0) > 0 ? (
            <Button to="/app/assistant" variant="outline" size="sm" block className="mt-4 sm:hidden">
              {t('payments.askToRemind')}
            </Button>
          ) : null}
        </Panel>

        <div className="mt-5 overflow-x-auto no-scrollbar">
          <Tabs
            value={tab}
            onChange={setTab}
            options={[
              { value: 'owed', label: t('payments.outstanding'), count: khata.data?.totals.count },
              { value: 'received', label: t('payments.collected') },
              { value: 'reminders', label: t('payments.reminders') },
            ]}
          />
        </div>

        <div className="mt-5">
          {tab === 'owed' ? (
            khata.loading && !khata.data ? (
              <Skeletons />
            ) : (khata.data?.commitments.length ?? 0) === 0 ? (
              <EmptyState
                icon={<Wallet className="size-6" />}
                title={t('payments.allSettled')}
                body={t('payments.allSettledBody')}
              />
            ) : (
              /* One divided list, not one card per debt — twenty outstanding
                 balances should read as a ledger, which is what it is. */
              <Panel className="divide-y divide-[var(--color-line)] px-4 sm:px-5">
                {khata.data!.commitments.map((commitment) => (
                  <Link
                    key={commitment.commitmentId}
                    to={`/app/customers/${commitment.customerId}`}
                    className="-mx-3 flex items-center gap-3 rounded-[var(--radius-control)] px-3 py-3 transition-colors hover:bg-[var(--color-sunken)]"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-[var(--color-ink)]">
                        {commitment.customerName}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-[var(--color-muted)]">
                        {commitment.description || '—'}
                      </p>
                    </div>

                    <div className="shrink-0 text-right">
                      <p className="text-sm font-bold text-[var(--color-ink)] tabular">
                        {formatMoney(commitment.remaining)}
                      </p>
                      <p
                        className={`mt-0.5 text-xs ${
                          commitment.isOverdue
                            ? 'font-semibold text-[var(--color-danger)]'
                            : 'text-[var(--color-muted)]'
                        }`}
                      >
                        {commitment.isOverdue
                          ? t('payments.daysOverdue', { days: commitment.daysOverdue })
                          : formatTimelineDate(commitment.dueDate, locale)}
                      </p>
                    </div>

                    {/* Reminder state is its own column: "reminded" and "not
                        sent" are facts about delivery, never about the debt. */}
                    <span className="hidden w-24 shrink-0 justify-end sm:flex">
                      {commitment.reminderStatus === 'sent' ? (
                        <StatusBadge tone="success">{t('payments.reminded')}</StatusBadge>
                      ) : commitment.reminderStatus === 'failed' ? (
                        <StatusBadge tone="warning">{t('payments.notSent')}</StatusBadge>
                      ) : null}
                    </span>
                  </Link>
                ))}
              </Panel>
            )
          ) : tab === 'received' ? (
            payments.loading && !payments.data ? (
              <Skeletons />
            ) : (payments.data?.payments.length ?? 0) === 0 ? (
              <EmptyState
                icon={<Wallet className="size-6" />}
                title={t('payments.empty')}
                body={t('payments.emptyBody')}
              />
            ) : (
              <>
                <Card className="mb-3 p-4">
                  <p className="text-xs font-semibold tracking-wide text-[var(--color-muted)] uppercase">
                    Last 30 days
                  </p>
                  <p className="mt-1 text-2xl font-extrabold text-[var(--color-success)] tabular">
                    {formatMoney(payments.data!.totals.collected)}
                  </p>

                  {/* Method mix, as proportional bars. */}
                  <div className="mt-3 space-y-1.5">
                    {Object.entries(payments.data!.totals.byMethod)
                      .sort((a, b) => b[1] - a[1])
                      .map(([method, amount]) => (
                        <div key={method} className="flex items-center gap-2">
                          <span className="w-14 shrink-0 text-xs text-[var(--color-muted)]">
                            {t(`payments.${method}`)}
                          </span>
                          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-sunken)]">
                            <span
                              className="block h-full rounded-full bg-[var(--color-primary)]"
                              style={{
                                width: `${(amount / payments.data!.totals.collected) * 100}%`,
                              }}
                            />
                          </span>
                          <span className="w-16 shrink-0 text-right text-xs font-semibold text-[var(--color-ink)] tabular">
                            {formatMoney(amount)}
                          </span>
                        </div>
                      ))}
                  </div>
                </Card>

                <Stagger className="space-y-2">
                  {payments.data!.payments.slice(0, 40).map((payment) => (
                    <StaggerItem key={payment.paymentId}>
                      <Card className="flex items-center justify-between gap-3 p-3.5">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-[var(--color-ink)]">
                            {payment.customerName}
                          </p>
                          <p className="text-xs text-[var(--color-muted)]">
                            {formatTimelineDate(payment.timestamp, locale)} ·{' '}
                            {t(`payments.${payment.method}`)}
                          </p>
                        </div>
                        <span className="shrink-0 text-sm font-bold text-[var(--color-success)] tabular">
                          {formatMoney(payment.amount)}
                        </span>
                      </Card>
                    </StaggerItem>
                  ))}
                </Stagger>
              </>
            )
          ) : (
            <>
              {/* Whether reminders can actually be delivered here.
                  Stated before the log, because a shopkeeper reading a list of
                  reminders needs to know whether any of them left the shop. */}
              {messaging.data ?? reminders.data ? (
                <ProviderBanner provider={messaging.data ?? reminders.data!.provider} />
              ) : null}

              {reminders.loading && !reminders.data ? (
                <Skeletons />
              ) : (reminders.data?.reminders.length ?? 0) === 0 ? (
                <EmptyState
                  icon={<Wallet className="size-6" />}
                  title="No reminders yet"
                  body="Reminders you prepare with Vyapio AI will be logged here."
                />
              ) : (
                <Stagger className="space-y-2">
                  {reminders.data!.reminders.map((reminder) => (
                    <StaggerItem key={reminder.notificationId}>
                      <Card className="p-3.5">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="text-xs leading-snug text-[var(--color-ink-soft)]">
                              {reminder.body}
                            </p>
                            <p className="mt-1.5 text-[11px] text-[var(--color-faint)]">
                              {formatTimelineDate(reminder.createdAt, locale)} · {reminder.to}
                            </p>
                          </div>

                          {/* Three distinct states, never collapsed into two. */}
                          <Badge
                            tone={
                              reminder.status === 'sent'
                                ? 'success'
                                : reminder.status === 'not_delivered'
                                  ? 'warning'
                                  : 'danger'
                            }
                            size="sm"
                          >
                            {reminder.status === 'sent'
                              ? t('payments.remindersSent')
                              : reminder.status === 'not_delivered'
                                ? t('payments.remindersNotDelivered')
                                : 'failed'}
                          </Badge>
                        </div>

                        {reminder.detail && reminder.status !== 'sent' ? (
                          <p className="mt-2 rounded-[var(--radius-control)] bg-[var(--color-sunken)] px-2.5 py-1.5 text-[11px] leading-snug text-[var(--color-muted)]">
                            {reminder.detail}
                          </p>
                        ) : null}
                      </Card>
                    </StaggerItem>
                  ))}
                </Stagger>
              )}
            </>
          )}
        </div>
      </PageBody>
    </PageTransition>
  );
}

/**
 * Whether messaging is wired up, and what to do when it is not.
 *
 * Three states rather than two: WhatsApp selected but half-configured looks
 * like success from the outside — credentials are set, the provider is not
 * "mock" — right up until a reminder is sent and Meta rejects it for having no
 * approved template. The shopkeeper finds out after telling a customer they
 * were reminded, which is the worst moment to find out.
 */
function ProviderBanner({
  provider,
}: {
  provider: {
    name: string;
    canDeliver: boolean;
    status: 'connected' | 'not_configured' | 'incomplete';
    template?: string;
    requiresOptIn: boolean;
    note: string;
  };
}) {
  const connected = provider.status === 'connected';

  return (
    <Card
      className={`mb-3 p-3.5 ${connected ? 'border-[var(--color-success)]' : 'border-[var(--color-warning)]'}`}
    >
      <div className="flex gap-2.5">
        {connected ? (
          <CircleCheck
            className="mt-0.5 size-4 shrink-0 text-[var(--color-success)]"
            aria-hidden="true"
          />
        ) : (
          <CircleAlert
            className="mt-0.5 size-4 shrink-0 text-[var(--color-warning)]"
            aria-hidden="true"
          />
        )}

        <div className="min-w-0">
          <p className="text-xs font-bold text-[var(--color-ink)]">
            {connected
              ? provider.name === 'whatsapp'
                ? 'WhatsApp connected'
                : `${provider.name.toUpperCase()} connected`
              : provider.status === 'incomplete'
                ? 'WhatsApp not finished'
                : 'No messaging provider'}
          </p>

          <p className="mt-0.5 text-xs leading-snug text-[var(--color-muted)]">{provider.note}</p>

          {/* The template name is the usual thing to get wrong, and it is not
              a secret — the token never leaves the server. */}
          {connected && provider.template ? (
            <p className="mt-1 text-[11px] text-[var(--color-faint)]">
              Template: <span className="font-medium">{provider.template}</span>
              {provider.requiresOptIn ? ' · only to customers who opted in' : ''}
            </p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function Skeletons() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 5 }).map((_, index) => (
        <Skeleton key={index} className="h-20" />
      ))}
    </div>
  );
}
