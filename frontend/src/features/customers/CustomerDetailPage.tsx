import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Banknote,
  CircleCheck,
  Package,
  Pencil,
  Phone,
  QrCode,
  Receipt,
  ShoppingBag,
  TriangleAlert,
  Wallet,
} from 'lucide-react';
import { PageBody, PageHeader, SectionHeading } from '@/components/layout/PageHeader';
import {
  Avatar,
  Button,
  Card,
  EmptyState,
  Input,
  Select,
  Sheet,
  Switch,
  Skeleton,
} from '@/components/ui';
import { PageTransition, Stagger, StaggerItem } from '@/components/motion';
import { QrCard } from './QrCard';
import { useT, useI18n } from '@/app/providers/I18nProvider';
import { useToast } from '@/app/providers/ToastProvider';
import { useOffline } from '@/app/providers/OfflineProvider';
import { useQuery } from '@/hooks/useApi';
import { api, ApiError } from '@/lib/api';
import {
  formatMoney,
  formatPhone,
  formatQuantity,
  formatTime,
  formatTimelineDate,
} from '@/lib/format';
import { cn } from '@/lib/cn';
import { PAYMENT_METHODS, type PaymentMethod } from '@shared/common';
import type { Commitment, Customer } from '@shared/entities';

/**
 * Customer memory.
 *
 * The brief's central instruction: this is a timeline, not an accounting
 * statement. Entries are grouped by day, each one reads as a sentence about
 * what happened, and the running balance sits at the top where it answers the
 * shopkeeper's actual question — *do they owe me anything?*
 */

type TimelineEntry = {
  id: string;
  kind: 'transaction' | 'payment' | 'order' | 'commitment';
  timestamp: string;
  title: string;
  subtitle: string;
  amount: number;
  paid?: number;
  pending?: number;
  paidAt?: string | null;
  items?: Array<{ name: string; quantity: number; unit: string; lineTotal: number }>;
  status?: string;
  source?: string;
};

type KhataResponse = {
  customer: Customer;
  summary: {
    totalSpent: number;
    purchaseCount: number;
    outstanding: number;
    openCommitments: number;
    overdueAmount: number;
    lastInteractionAt: string | null;
  };
  timeline: TimelineEntry[];
  commitments: Commitment[];
};

export default function CustomerDetailPage() {
  const t = useT();
  const { locale } = useI18n();
  const navigate = useNavigate();
  const { customerId } = useParams<{ customerId: string }>();

  const [qrOpen, setQrOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [phoneOpen, setPhoneOpen] = useState(false);

  const { data, loading, error, refetch } = useQuery<KhataResponse>(
    customerId ? `/khata/${customerId}` : null,
  );

  // Grouping by calendar day is what turns a list of rows into a story.
  const days = useMemo(() => {
    if (!data) return [];
    const groups = new Map<string, TimelineEntry[]>();
    for (const entry of data.timeline) {
      const key = entry.timestamp.slice(0, 10);
      const existing = groups.get(key);
      if (existing) existing.push(entry);
      else groups.set(key, [entry]);
    }
    return [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [data]);

  if (loading && !data) {
    return (
      <PageTransition>
        <PageHeader title={t('common.loading')} back />
        <PageBody>
          <Skeleton className="h-36" />
          <Skeleton className="mt-4 h-24" />
          <Skeleton className="mt-4 h-24" />
        </PageBody>
      </PageTransition>
    );
  }

  if (error || !data) {
    return (
      <PageTransition>
        <PageHeader title={t('errors.notFound')} back />
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

  const { customer, summary } = data;

  return (
    <PageTransition>
      <PageHeader
        title={customer.name}
        back
        actions={
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setQrOpen(true)}
            aria-label={t('customers.showQr')}
          >
            <QrCode className="size-5" aria-hidden="true" />
          </Button>
        }
      />

      <PageBody>
        {/* ── The answer, before anything else ──────────────────────────── */}
        <Card className="overflow-hidden">
          <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-center gap-4">
              <Avatar name={customer.name} size="xl" />
              <div className="min-w-0">
                <p className="text-2xl font-extrabold text-[var(--color-ink)] tabular">
                  {formatMoney(summary.totalSpent)}
                </p>
                <p className="mt-0.5 text-sm text-[var(--color-muted)]">
                  {t('customers.spent')} · {summary.purchaseCount} {t('customers.purchases')}
                </p>
                <PhoneLine customer={customer} onEdit={() => setPhoneOpen(true)} />
              </div>
            </div>

            <BalanceCallout
              outstanding={summary.outstanding}
              overdue={summary.overdueAmount}
              openCommitments={summary.openCommitments}
            />
          </div>

          <div className="grid grid-cols-2 border-t border-[var(--color-line)]">
            <button
              type="button"
              onClick={() => navigate(`/app/sales/new?customerId=${customer.customerId}`)}
              className="flex items-center justify-center gap-2 py-3.5 text-sm font-semibold text-[var(--color-ink)] transition-colors active:bg-[var(--color-sunken)]"
            >
              <ShoppingBag className="size-4 text-[var(--color-primary)]" aria-hidden="true" />
              {t('customers.newSale')}
            </button>
            <button
              type="button"
              onClick={() => setPayOpen(true)}
              disabled={summary.outstanding <= 0}
              className="flex items-center justify-center gap-2 border-l border-[var(--color-line)] py-3.5 text-sm font-semibold text-[var(--color-ink)] transition-colors active:bg-[var(--color-sunken)] disabled:opacity-40"
            >
              <Banknote className="size-4 text-[var(--color-success)]" aria-hidden="true" />
              {t('customers.recordPayment')}
            </button>
          </div>
        </Card>

        {/* ── Timeline ──────────────────────────────────────────────────── */}
        <section className="mt-7">
          <SectionHeading title={t('customers.timeline')} />

          {days.length === 0 ? (
            <EmptyState
              icon={<Receipt className="size-6" />}
              title={t('customers.timelineEmpty')}
              body={t('customers.timelineEmptyBody')}
            />
          ) : (
            <Stagger className="space-y-5">
              {days.map(([day, entries]) => (
                <StaggerItem key={day}>
                  <div className="mb-2 flex items-center gap-3">
                    <h3 className="text-xs font-bold tracking-wide text-[var(--color-muted)] uppercase">
                      {formatTimelineDate(`${day}T12:00:00.000Z`, locale)}
                    </h3>
                    <span className="h-px flex-1 bg-[var(--color-line)]" aria-hidden="true" />
                  </div>

                  <div className="space-y-2">
                    {entries.map((entry) => (
                      <TimelineCard key={entry.id} entry={entry} locale={locale} />
                    ))}
                  </div>
                </StaggerItem>
              ))}
            </Stagger>
          )}
        </section>
      </PageBody>

      <Sheet open={qrOpen} onClose={() => setQrOpen(false)} title={t('customers.showQr')}>
        <QrCard customerId={customer.customerId} customerName={customer.name} />
      </Sheet>

      <PhoneSheet
        open={phoneOpen}
        onClose={() => setPhoneOpen(false)}
        customer={customer}
        onSaved={() => void refetch()}
      />

      <RecordPaymentSheet
        open={payOpen}
        onClose={() => setPayOpen(false)}
        customer={customer}
        outstanding={summary.outstanding}
        onRecorded={() => void refetch()}
      />
    </PageTransition>
  );
}

const KIND_META = {
  transaction: { icon: ShoppingBag, tone: 'text-[var(--color-primary)]' },
  payment: { icon: Banknote, tone: 'text-[var(--color-success)]' },
  order: { icon: Package, tone: 'text-[var(--color-gold)]' },
  commitment: { icon: Wallet, tone: 'text-[var(--color-warning)]' },
} as const;

/**
 * What this customer owes, as the loudest thing on the screen.
 *
 * This is the question the shopkeeper opened the page to answer, so it gets a
 * tinted panel and the largest figure rather than a chip beside the lifetime
 * spend. Lifetime spend is trivia; an unpaid balance is a decision.
 *
 * The split matters as much as the total. "₹1,043 due" invites a shrug;
 * "₹733 of it is overdue" is the sentence that gets someone to pick up the
 * phone — so overdue is broken out and carries the red, while the remainder
 * is named as merely not-yet-due rather than being folded in silently.
 *
 * Colour never works alone: the icon and the words "overdue" / "all settled"
 * carry the same state for anyone who cannot separate red from green.
 */
function BalanceCallout({
  outstanding,
  overdue,
  openCommitments,
}: {
  outstanding: number;
  overdue: number;
  openCommitments: number;
}) {
  const t = useT();

  if (outstanding <= 0) {
    return (
      <div className="flex items-center gap-2.5 rounded-[var(--radius-card)] border border-[var(--color-success)]/30 bg-[var(--color-success-soft)] px-4 py-3 sm:min-w-[13rem]">
        <CircleCheck
          className="size-5 shrink-0 text-[var(--color-success)]"
          aria-hidden="true"
        />
        <div>
          <p className="text-sm font-bold text-[var(--color-success)]">
            {t('customers.allSettled')}
          </p>
          <p className="text-xs text-[var(--color-muted)]">{t('customers.nothingDue')}</p>
        </div>
      </div>
    );
  }

  const isOverdue = overdue > 0;
  const upcoming = Math.max(0, outstanding - overdue);

  return (
    <div
      className={cn(
        'rounded-[var(--radius-card)] border px-4 py-3 sm:min-w-[13rem]',
        isOverdue
          ? 'border-[var(--color-danger)]/35 bg-[var(--color-danger-soft)]'
          : 'border-[var(--color-warning)]/35 bg-[var(--color-warning-soft)]',
      )}
      role="status"
    >
      <div className="flex items-center gap-1.5">
        <TriangleAlert
          className={cn(
            'size-3.5 shrink-0',
            isOverdue ? 'text-[var(--color-danger)]' : 'text-[var(--color-warning)]',
          )}
          aria-hidden="true"
        />
        <p
          className={cn(
            'text-[length:var(--text-eyebrow)] font-bold tracking-[0.08em] uppercase',
            isOverdue ? 'text-[var(--color-danger)]' : 'text-[var(--color-warning)]',
          )}
        >
          {t('customers.totalDue')}
        </p>
      </div>

      <p
        className={cn(
          'mt-1 text-[length:var(--text-metric)] leading-none font-extrabold tracking-tight tabular',
          isOverdue ? 'text-[var(--color-danger)]' : 'text-[var(--color-warning)]',
        )}
      >
        {formatMoney(outstanding)}
      </p>

      <div className="mt-2 space-y-0.5 border-t border-current/10 pt-2">
        {isOverdue ? (
          <p className="flex items-baseline justify-between gap-3 text-xs">
            <span className="font-semibold text-[var(--color-danger)]">
              {t('payments.overdue')}
            </span>
            <span className="font-bold text-[var(--color-danger)] tabular">
              {formatMoney(overdue)}
            </span>
          </p>
        ) : null}

        {upcoming > 0 ? (
          <p className="flex items-baseline justify-between gap-3 text-xs">
            <span className="text-[var(--color-muted)]">{t('customers.notYetDue')}</span>
            <span className="font-semibold text-[var(--color-ink-soft)] tabular">
              {formatMoney(upcoming)}
            </span>
          </p>
        ) : null}

        {openCommitments > 0 ? (
          <p className="pt-0.5 text-[11px] text-[var(--color-muted)]">
            {t('customers.acrossBills', { count: openCommitments })}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function TimelineCard({ entry, locale }: { entry: TimelineEntry; locale: string }) {
  const t = useT();
  const { icon: Icon, tone } = KIND_META[entry.kind];

  return (
    <Card className="p-3.5">
      <div className="flex gap-3">
        <span className={`mt-0.5 shrink-0 ${tone}`}>
          <Icon className="size-4.5" aria-hidden="true" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-[var(--color-ink)]">{entry.title}</p>
              <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                {formatTime(entry.timestamp, locale)} · {entry.subtitle}
                {/* Provenance: voice and agent rows are labelled, so an
                    AI-written entry is never indistinguishable from a typed one. */}
                {entry.source && entry.source !== 'manual' && entry.source !== 'seed'
                  ? ` · ${entry.source}`
                  : ''}
              </p>
            </div>

            <span className="shrink-0 text-right">
              <span className="block text-sm font-bold text-[var(--color-ink)] tabular">
                {formatMoney(entry.amount)}
              </span>
              {entry.pending && entry.pending > 0 ? (
                <span className="block text-xs font-medium text-[var(--color-warning)] tabular">
                  {formatMoney(entry.pending)} {t('common.pending').toLowerCase()}
                </span>
              ) : entry.paid !== undefined && entry.paid > 0 ? (
                <span className="block text-xs text-[var(--color-success)]">
                  {t('common.paid')}
                </span>
              ) : null}
              {/* When the money came in. "Paid" with no date is a claim the
                  shopkeeper cannot check against what the customer remembers. */}
              {entry.paidAt ? (
                <span className="block text-[11px] whitespace-nowrap text-[var(--color-faint)]">
                  {formatTimelineDate(entry.paidAt, locale)} · {formatTime(entry.paidAt, locale)}
                </span>
              ) : null}
            </span>
          </div>

          {entry.items && entry.items.length > 0 ? (
            <ul className="mt-2 space-y-0.5">
              {entry.items.map((item, index) => (
                <li
                  key={`${entry.id}-${index}`}
                  className="flex justify-between text-xs text-[var(--color-ink-soft)]"
                >
                  <span className="truncate">
                    {formatQuantity(item.quantity, item.unit)} {item.name}
                  </span>
                  <span className="shrink-0 pl-3 tabular">{formatMoney(item.lineTotal)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

/**
 * The customer's number, or the way to add one.
 *
 * A shop's whole follow-up — a reminder about money owed, a call when an order
 * is ready — runs on having a number, and until now the only place to enter one
 * was the form that created the customer. Anyone added by voice mid-sale, which
 * is most of them, had no number and no way to get one short of a second,
 * duplicate customer.
 *
 * Deliberately a line of text rather than a button: on a page whose job is to
 * answer "what does this person owe me", a contact detail is not the headline.
 */
function PhoneLine({ customer, onEdit }: { customer: Customer; onEdit: () => void }) {
  const t = useT();

  if (!customer.phone) {
    return (
      <button
        type="button"
        onClick={onEdit}
        className="mt-1.5 -ml-1 inline-flex items-center gap-1.5 rounded-[var(--radius-control)] px-1 py-0.5 text-sm font-semibold text-[var(--color-primary)] transition-colors hover:bg-[var(--color-primary-soft)]"
      >
        <Phone className="size-3.5" aria-hidden="true" />
        {t('customers.addPhone')}
      </button>
    );
  }

  return (
    <p className="mt-1.5 flex items-center gap-1.5 text-sm">
      <Phone className="size-3.5 shrink-0 text-[var(--color-muted)]" aria-hidden="true" />
      {/* A real tel: link — one tap to call on the phone the shopkeeper is
          holding, and the browser's own copy action on a desktop. */}
      <a
        href={`tel:+91${customer.phone}`}
        aria-label={t('customers.callCustomer').replace('{name}', customer.name)}
        className="font-medium text-[var(--color-ink)] tabular hover:text-[var(--color-primary)] hover:underline"
      >
        +91 {formatPhone(customer.phone)}
      </a>
      <button
        type="button"
        onClick={onEdit}
        aria-label={t('customers.editPhone')}
        className="rounded-[var(--radius-control)] p-1 text-[var(--color-faint)] transition-colors hover:bg-[var(--color-sunken)] hover:text-[var(--color-primary)]"
      >
        <Pencil className="size-3.5" aria-hidden="true" />
      </button>
    </p>
  );
}

/**
 * Adding or changing that number.
 *
 * The same `Sheet` the rest of the app uses, so this is one more of the sheets
 * a shopkeeper already knows rather than a new kind of window.
 *
 * `+91` is fixed rather than a country picker because the API stores Indian
 * ten-digit numbers and rejects anything else — offering a choice the server
 * will refuse is worse than not offering it. Every other phone field in the app
 * is built the same way.
 */
function PhoneSheet({
  open,
  onClose,
  customer,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  customer: Customer;
  onSaved: () => void;
}) {
  const t = useT();
  const toast = useToast();

  const [digits, setDigits] = useState(customer.phone);
  /**
   * A separate WhatsApp number, only when the shop has one.
   *
   * Left empty means "the same number", which is the usual case — and
   * assuming it when it is not true sends a stranger a message about someone
   * else's debt, so it has to be recorded rather than guessed.
   */
  const [whatsapp, setWhatsapp] = useState(customer.whatsappPhone ?? '');
  const [optIn, setOptIn] = useState(customer.whatsappOptIn ?? false);
  const [error, setError] = useState<ApiError | null>(null);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  /**
   * Reopening after a cancel shows what is saved, not what was abandoned.
   *
   * Adjusted as the sheet opens rather than in an effect: React re-runs this
   * render before anything paints, so the discarded number never flashes on
   * screen the way it would if the reset arrived a frame later.
   */
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setDigits(customer.phone);
      setWhatsapp(customer.whatsappPhone ?? '');
      setOptIn(customer.whatsappOptIn ?? false);
      setError(null);
      setTouched(false);
    }
  }

  const valid = /^[6-9]\d{9}$/.test(digits);
  // Empty is fine — it means "use the number above".
  const whatsappValid = whatsapp === '' || /^[6-9]\d{9}$/.test(whatsapp);

  const submit = async () => {
    setTouched(true);
    if (!valid || !whatsappValid) return;

    setBusy(true);
    setError(null);
    try {
      await api.patch(`/customers/${customer.customerId}`, {
        phone: digits,
        whatsappPhone: whatsapp,
        whatsappOptIn: optIn,
      });
      toast.success(t('customers.saveNumber'), `+91 ${formatPhone(digits)}`);
      onClose();
      // Re-read rather than patch local state: the page is driven by the
      // server's copy, and a screen that believes a save it never confirmed is
      // how a number ends up shown but not stored.
      onSaved();
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
      title={customer.phone ? t('customers.editPhone') : t('customers.addPhone')}
      description={t('customers.phoneSheetBody')}
      footer={
        <div className="flex gap-2">
          <Button variant="outline" size="lg" block onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button size="lg" block loading={busy} onClick={() => void submit()}>
            {t('customers.saveNumber')}
          </Button>
        </div>
      }
    >
      <div className="space-y-4 pb-2">
        <Input
          type="tel"
          inputMode="numeric"
          autoComplete="tel-national"
          label={t('auth.phone')}
          value={digits}
          // Digits only, capped at ten: the field already shows +91, so a
          // pasted "+91 98765 43210" would otherwise be stored with the code
          // repeated.
          onChange={(event) => setDigits(event.target.value.replace(/\D/g, '').slice(0, 10))}
          prefix="+91"
          placeholder={t('customers.phonePlaceholder')}
          autoFocus
          {...(touched && !valid
            ? { error: t('customers.phoneInvalid') }
            : error?.issueFor('phone')
              ? { error: error.issueFor('phone') }
              : { hint: t('customers.phoneHint') })}
        />

        {/* WhatsApp, for payment reminders.
            Optional, and empty means the number above. */}
        <Input
          type="tel"
          inputMode="numeric"
          label={`${t('customers.whatsappNumber')} (${t('common.optional')})`}
          value={whatsapp}
          onChange={(event) => setWhatsapp(event.target.value.replace(/\D/g, '').slice(0, 10))}
          prefix="+91"
          placeholder={t('customers.whatsappSame')}
          {...(touched && !whatsappValid
            ? { error: t('customers.phoneInvalid') }
            : { hint: t('customers.whatsappHint') })}
        />

        <Switch
          checked={optIn}
          onChange={setOptIn}
          label={t('customers.whatsappOptIn')}
          description={t('customers.whatsappOptInHint')}
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

function RecordPaymentSheet({
  open,
  onClose,
  customer,
  outstanding,
  onRecorded,
}: {
  open: boolean;
  onClose: () => void;
  customer: Customer;
  outstanding: number;
  onRecorded: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const { online, enqueue } = useOffline();

  const [rupees, setRupees] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const amountPaise = Math.round((Number(rupees) || 0) * 100);
  const valid = amountPaise > 0;

  const submit = async () => {
    if (!valid) return;
    const payload = { customerId: customer.customerId, amount: amountPaise, method, note: '' };

    if (!online) {
      enqueue({
        kind: 'payment',
        payload,
        label: `${formatMoney(amountPaise)} from ${customer.name}`,
      });
      toast.info(t('offline.notSavedYet'), formatMoney(amountPaise));
      setRupees('');
      onClose();
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await api.post('/khata/payment', payload, { idempotencyKey: crypto.randomUUID() });
      toast.success('Payment recorded', `${formatMoney(amountPaise)} from ${customer.name}`);
      setRupees('');
      onClose();
      onRecorded();
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
      title={t('customers.recordPayment')}
      description={`${customer.name} · ${formatMoney(outstanding)} ${t('customers.owes')}`}
      footer={
        <Button size="lg" block loading={busy} disabled={!valid} onClick={() => void submit()}>
          {online ? t('common.save') : t('offline.notSavedYet')}
        </Button>
      }
    >
      <div className="space-y-4 pb-2">
        <Input
          type="number"
          inputMode="decimal"
          label={t('payments.amount')}
          value={rupees}
          onChange={(event) => setRupees(event.target.value)}
          prefix="₹"
          placeholder="0"
          autoFocus
          className="text-xl font-bold"
          {...(error?.issueFor('amount') ? { error: error.issueFor('amount') } : {})}
        />

        {/* One tap to settle the whole balance — the common case. */}
        {outstanding > 0 ? (
          <button
            type="button"
            onClick={() => setRupees(String(outstanding / 100))}
            className="text-sm font-semibold text-[var(--color-primary)] hover:underline"
          >
            Settle everything ({formatMoney(outstanding)})
          </button>
        ) : null}

        <Select
          label={t('payments.method')}
          value={method}
          onChange={(event) => setMethod(event.target.value as PaymentMethod)}
        >
          {PAYMENT_METHODS.filter((entry) => entry !== 'credit').map((entry) => (
            <option key={entry} value={entry}>
              {t(`payments.${entry}`)}
            </option>
          ))}
        </Select>

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
