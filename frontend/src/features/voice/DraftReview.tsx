import { useState } from 'react';
import { motion } from 'framer-motion';
import {
  Boxes,
  Check,
  ChevronRight,
  Pencil,
  Quote,
  RotateCcw,
  Sparkles,
  TriangleAlert,
  User,
  Wallet,
} from 'lucide-react';
import { Avatar, Button, Input, StatusBadge } from '@/components/ui';
import { Counter, Stagger, StaggerItem } from '@/components/motion';
import { useT } from '@/app/providers/I18nProvider';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { TransactionDraft } from '@shared/ai';

type Availability = TransactionDraft['items'][number]['availability'];

/**
 * One place where a draft's money is derived from its lines.
 *
 * Every edit funnels through here so an edited draft cannot drift from the one
 * the server produced: the total counts only fulfilled quantities, what is
 * still owed never goes below zero, and anything paid beyond the bill is change
 * to hand back rather than a negative balance.
 */
function recalculate(draft: TransactionDraft): TransactionDraft {
  const subtotal = draft.items.reduce((sum, item) => sum + item.lineTotal, 0);
  const total = Math.max(0, subtotal - draft.discount);

  return {
    ...draft,
    subtotal,
    total,
    outstanding: Math.max(0, total - draft.paid),
    change: Math.max(0, draft.paid - total),
    unfulfilledCount: draft.items.filter((item) => item.availability !== 'available').length,
  };
}

const AVAILABILITY_LABEL: Record<Availability, string> = {
  available: 'AVAILABLE',
  insufficient: 'INSUFFICIENT STOCK',
  unavailable: 'NOT AVAILABLE',
};

const AVAILABILITY_TONE = {
  available: 'success',
  insufficient: 'warning',
  unavailable: 'danger',
} as const;

/**
 * Says what the shop can do about this line.
 *
 * Shown on every line including the ones that can be supplied in full, because
 * a badge that only appears when something is wrong trains the eye to skip the
 * column, and then the one time it matters it is missed.
 */
function AvailabilityBadge({ status }: { status: Availability }) {
  return (
    <StatusBadge tone={AVAILABILITY_TONE[status]} className="shrink-0">
      {AVAILABILITY_LABEL[status]}
    </StatusBadge>
  );
}

/**
 * The transaction review card.
 *
 * This screen has to do two contradictory things at once: feel like a finished,
 * confident receipt, *and* make it obvious that nothing has been saved yet. So
 * the layout is receipt-shaped and the money is large — but the whole card is
 * topped by a "draft" ribbon, the confirm button is the only filled control,
 * and anything the parser was unsure about sits above the numbers rather than
 * below them, where it would be scrolled past.
 */
export function DraftReview({
  draft,
  onChange,
  onConfirm,
  onSpeakAgain,
  saving,
  online,
}: {
  draft: TransactionDraft;
  onChange: (draft: TransactionDraft) => void;
  onConfirm: () => void;
  onSpeakAgain: () => void;
  saving: boolean;
  online: boolean;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);

  /**
   * Recomputes a line and the totals, keeping availability in step.
   *
   * A hand-edited quantity is the shopkeeper overruling the shelf — they can
   * see the stock figure and may know something the record does not. So the
   * edited number becomes the fulfilled quantity, and the status is re-derived
   * from it against the same available figure the server sent. Leaving the old
   * badge in place would label a corrected line with a stale warning.
   */
  const updateItem = (index: number, patch: Partial<TransactionDraft['items'][number]>) => {
    const items = draft.items.map((item, i) => {
      if (i !== index) return item;

      const quantity = patch.quantity ?? item.quantity;
      const unitPrice = patch.unitPrice ?? item.unitPrice;
      const availability: Availability =
        quantity <= 0
          ? 'unavailable'
          : quantity <= item.availableQuantity
            ? 'available'
            : 'insufficient';

      return {
        ...item,
        ...patch,
        quantity,
        unitPrice,
        fulfilledQuantity: quantity,
        availability,
        lineTotal: Math.round(unitPrice * quantity),
      };
    });

    onChange(recalculate({ ...draft, items }));
  };

  const setPaid = (rupees: number) => {
    // Not clamped to the total: paying more than the bill is change, and the
    // shopkeeper types the note they were handed, not the amount owed.
    const paid = Math.max(0, Math.round(rupees * 100));
    onChange(recalculate({ ...draft, paid }));
  };

  /**
   * How many lines the shop cannot supply in full, and whether there is
   * anything left to sell at all.
   *
   * `canSave` deliberately requires a *fulfillable* line rather than just a
   * line: a draft made entirely of out-of-stock items has a total of zero, and
   * confirming it would write an empty sale against the customer's name.
   */
  const unfulfilled = draft.items.filter((item) => item.availability !== 'available').length;
  const fulfillable = draft.items.filter((item) => item.fulfilledQuantity > 0).length;

  /**
   * A name the shop has not saved yet still counts as a customer.
   *
   * The card above already says "New — will be created", so blocking here
   * contradicted the screen's own promise and left no way forward: the sale had
   * to be abandoned and re-spoken after adding the person by hand. Confirming
   * creates them.
   */
  const haveCustomer = Boolean(draft.customerId) || (draft.customerIsNew && Boolean(draft.customerName.trim()));
  const canSave = haveCustomer && fulfillable > 0;
  const confidencePercent = Math.round(draft.confidence * 100);

  return (
    <div className="pb-4">
      {/* ── Heading ───────────────────────────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-5 text-center"
      >
        <h2 className="font-[family-name:var(--font-display)] text-3xl leading-tight text-[var(--color-ink)]">
          {t('voice.ready')}
        </h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">{t('voice.heard')}</p>
      </motion.div>

      {/* ── What we were unsure about ─────────────────────────────────────── */}
      {draft.warnings.length > 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="mb-4 overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-warning)]/40 bg-[var(--color-warning-soft)]"
        >
          <div className="flex items-center gap-2 px-4 pt-3.5 pb-2">
            <TriangleAlert className="size-4 text-[var(--color-warning)]" aria-hidden="true" />
            <p className="text-sm font-bold text-[var(--color-warning)]">
              {t('voice.checkThese')}
            </p>
          </div>
          <ul className="space-y-1.5 px-4 pb-3.5">
            {draft.warnings.map((warning, index) => (
              <li
                key={index}
                className="flex gap-2 text-sm leading-snug text-[var(--color-ink-soft)]"
              >
                <span className="mt-[0.45rem] size-1 shrink-0 rounded-full bg-[var(--color-warning)]" />
                {warning}
              </li>
            ))}
          </ul>
        </motion.div>
      ) : null}

      {/* ── The receipt ───────────────────────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1, type: 'spring', stiffness: 280, damping: 30 }}
        className="relative overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] shadow-[var(--shadow-lift)]"
      >
        {/* Ribbon: the card looks finished, so it must say that it is not. */}
        <div className="flex items-center justify-between gap-3 bg-[var(--color-ink)] px-4 py-2">
          <span className="flex items-center gap-1.5 text-[11px] font-bold tracking-widest text-white/90 uppercase">
            <span className="size-1.5 animate-pulse rounded-full bg-[var(--color-accent)]" />
            Draft · not saved yet
          </span>
          <span className="text-[11px] font-medium text-white/50 tabular">
            {confidencePercent}% confident
          </span>
        </div>

        {/* ── Customer ────────────────────────────────────────────────────── */}
        <div className="border-b border-dashed border-[var(--color-line-strong)] px-4 py-4">
          <p className="mb-2 flex items-center gap-1.5 text-[11px] font-bold tracking-widest text-[var(--color-muted)] uppercase">
            <User className="size-3" aria-hidden="true" />
            Customer
          </p>

          {draft.customerCandidates.length > 1 ? (
            <div className="space-y-1.5">
              <p className="text-sm font-medium text-[var(--color-warning)]">Which one?</p>
              {draft.customerCandidates.map((candidate) => (
                <button
                  key={candidate.customerId}
                  type="button"
                  onClick={() =>
                    onChange({
                      ...draft,
                      customerId: candidate.customerId,
                      customerName: candidate.name,
                      customerCandidates: [],
                      warnings: draft.warnings.filter((w) => !w.includes('More than one')),
                    })
                  }
                  className="flex w-full items-center gap-3 rounded-[var(--radius-field)] border border-[var(--color-line)] p-2.5 text-left transition-colors active:bg-[var(--color-sunken)]"
                >
                  <Avatar name={candidate.name} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-[var(--color-ink)]">
                      {candidate.name}
                    </span>
                    <span className="block text-xs text-[var(--color-muted)]">
                      {candidate.phone || '—'}
                    </span>
                  </span>
                  <ChevronRight className="size-4 text-[var(--color-faint)]" aria-hidden="true" />
                </button>
              ))}
            </div>
          ) : draft.customerName ? (
            <div className="flex items-center gap-3">
              <Avatar name={draft.customerName} size="lg" />
              <div className="min-w-0">
                <p className="truncate text-xl font-bold text-[var(--color-ink)]">
                  {draft.customerName}
                </p>
                {draft.customerIsNew ? (
                  <span className="mt-0.5 inline-block rounded-full bg-[var(--color-warning-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--color-warning)]">
                    New — will be created
                  </span>
                ) : (
                  <p className="text-xs text-[var(--color-muted)]">Saved customer</p>
                )}
              </div>
            </div>
          ) : (
            <p className="rounded-[var(--radius-field)] bg-[var(--color-sunken)] px-3 py-2.5 text-sm text-[var(--color-muted)]">
              No name was heard — pick a customer before saving.
            </p>
          )}
        </div>

        {/* ── Items ───────────────────────────────────────────────────────── */}
        <div>
          <div className="flex items-center justify-between px-4 pt-3.5 pb-1">
            <p className="flex items-center gap-1.5 text-[11px] font-bold tracking-widest text-[var(--color-muted)] uppercase">
              <Boxes className="size-3" aria-hidden="true" />
              {draft.items.length} {draft.items.length === 1 ? 'item' : 'items'}
            </p>
            {draft.items.length > 0 ? (
              <button
                type="button"
                onClick={() => setEditing((value) => !value)}
                className="text-[11px] font-bold tracking-wide text-[var(--color-primary)] uppercase"
              >
                {editing ? t('common.done') : t('voice.edit')}
              </button>
            ) : null}
          </div>

          {draft.items.length === 0 ? (
            <div className="mx-4 mb-3 rounded-[var(--radius-field)] border border-dashed border-[var(--color-line-strong)] px-4 py-6 text-center">
              <Boxes className="mx-auto size-5 text-[var(--color-faint)]" aria-hidden="true" />
              <p className="mt-2 text-sm text-[var(--color-muted)]">No products recognised</p>
              <p className="mt-0.5 text-xs text-[var(--color-faint)]">
                Speak again, or add them by hand
              </p>
            </div>
          ) : (
            <Stagger className="divide-y divide-[var(--color-line)]" step={0.04}>
              {draft.items.map((item, index) => (
                <StaggerItem key={index}>
                  <div className="flex items-center gap-3 px-4 py-3">
                    {/*
                      Quantity chip — the number a shopkeeper checks first.
                      It shows what would actually be handed over. When that is
                      less than was asked for, the request is spelled out
                      underneath rather than silently replaced by this figure.
                    */}
                    <span
                      className={cn(
                        'flex min-w-12 shrink-0 flex-col items-center justify-center rounded-[var(--radius-field)] px-2 py-1.5',
                        item.availability === 'available'
                          ? 'bg-[var(--color-primary-soft)]'
                          : item.availability === 'insufficient'
                            ? 'bg-[var(--color-warning-soft)]'
                            : 'bg-[var(--color-danger-soft)]',
                      )}
                    >
                      <span
                        className={cn(
                          'text-base leading-none font-extrabold tabular',
                          item.availability === 'available'
                            ? 'text-[var(--color-primary)]'
                            : item.availability === 'insufficient'
                              ? 'text-[var(--color-warning)]'
                              : 'text-[var(--color-danger)]',
                        )}
                      >
                        {item.fulfilledQuantity ?? item.quantity}
                      </span>
                      <span
                        className={cn(
                          'mt-0.5 text-[10px] leading-none font-semibold',
                          item.availability === 'available'
                            ? 'text-[var(--color-primary)]/70'
                            : item.availability === 'insufficient'
                              ? 'text-[var(--color-warning)]/80'
                              : 'text-[var(--color-danger)]/80',
                        )}
                      >
                        {item.unit === 'unit' ? 'nos' : item.unit}
                      </span>
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <p className="truncate text-sm font-bold text-[var(--color-ink)]">
                          {item.name}
                        </p>
                        <AvailabilityBadge status={item.availability} />
                      </div>
                      <p className="text-xs text-[var(--color-muted)] tabular">
                        {formatMoney(item.unitPrice)} each
                        {!item.inCatalogue ? (
                          <span className="ml-1.5 text-[var(--color-danger)]">
                            · not in your stock list
                          </span>
                        ) : null}
                      </p>
                      {item.availability === 'insufficient' ? (
                        <p className="mt-0.5 text-xs font-semibold text-[var(--color-warning)] tabular">
                          Asked for {item.requestedQuantity} · only {item.availableQuantity} left ·
                          short by {item.requestedQuantity - item.fulfilledQuantity}
                        </p>
                      ) : null}
                      {item.availability === 'unavailable' ? (
                        <p className="mt-0.5 text-xs font-semibold text-[var(--color-danger)] tabular">
                          Asked for {item.requestedQuantity} · none in stock · not charged
                        </p>
                      ) : null}
                    </div>

                    {editing ? (
                      <div className="flex shrink-0 gap-1.5">
                        <Input
                          type="number"
                          inputMode="decimal"
                          value={String(item.quantity)}
                          onChange={(event) =>
                            updateItem(index, { quantity: Number(event.target.value) || 0 })
                          }
                          className="h-10 w-16 text-center text-sm"
                          aria-label={`${item.name} quantity`}
                        />
                        <Input
                          type="number"
                          inputMode="decimal"
                          value={String(item.unitPrice / 100)}
                          onChange={(event) =>
                            updateItem(index, {
                              unitPrice: Math.round((Number(event.target.value) || 0) * 100),
                            })
                          }
                          className="h-10 w-20 text-center text-sm"
                          aria-label={`${item.name} price`}
                        />
                      </div>
                    ) : (
                      <span className="shrink-0 text-sm font-bold text-[var(--color-ink)] tabular">
                        {formatMoney(item.lineTotal)}
                      </span>
                    )}
                  </div>
                </StaggerItem>
              ))}
            </Stagger>
          )}
        </div>

        {/* ── Money ───────────────────────────────────────────────────────── */}
        <div className="relative border-t border-dashed border-[var(--color-line-strong)] bg-[var(--color-sunken)] px-4 py-4">
          {/* Perforation notches, so the block reads as a torn-off receipt. */}
          <span
            className="absolute -top-2 -left-2 size-4 rounded-full bg-[var(--color-bg)]"
            aria-hidden="true"
          />
          <span
            className="absolute -top-2 -right-2 size-4 rounded-full bg-[var(--color-bg)]"
            aria-hidden="true"
          />

          <div className="flex items-end justify-between gap-4">
            <span className="text-sm font-medium text-[var(--color-muted)]">
              {t('common.total')}
            </span>
            <span className="text-3xl leading-none font-extrabold text-[var(--color-ink)]">
              <Counter value={draft.total} format={(value) => formatMoney(value)} />
            </span>
          </div>

          <div className="mt-4 space-y-2.5">
            {editing ? (
              <Input
                type="number"
                inputMode="decimal"
                label={t('sales.amountPaid')}
                value={String(draft.paid / 100)}
                onChange={(event) => setPaid(Number(event.target.value) || 0)}
                prefix="₹"
              />
            ) : (
              <SplitRow
                label={t('common.paid')}
                value={draft.paid}
                total={draft.total}
                tone="success"
              />
            )}

            {draft.outstanding > 0 ? (
              <SplitRow
                label={t('common.pending')}
                value={draft.outstanding}
                total={draft.total}
                tone="warning"
              />
            ) : null}

            {/*
              Money to hand back, not a negative balance. The two are opposite
              directions and a khata screen reads any figure here as "owed to
              the shop", so an overpayment gets its own row and its own word.
            */}
            {(draft.change ?? 0) > 0 ? (
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-[var(--color-muted)]">
                  {t('voice.change')}
                </span>
                <span className="text-sm font-bold text-[var(--color-success)] tabular">
                  {formatMoney(draft.change)}
                </span>
              </div>
            ) : null}
          </div>

          <div className="mt-3.5 flex items-center gap-2 border-t border-[var(--color-line)] pt-3">
            <Wallet className="size-3.5 text-[var(--color-faint)]" aria-hidden="true" />
            <span className="text-xs font-semibold tracking-wide text-[var(--color-muted)] uppercase">
              {draft.paymentMethod}
            </span>
            {draft.outstanding > 0 ? (
              <span className="ml-auto text-xs text-[var(--color-warning)]">
                Added to their khata
              </span>
            ) : (
              <span className="ml-auto text-xs text-[var(--color-success)]">Settled in full</span>
            )}
          </div>
        </div>
      </motion.div>

      {/* ── Provenance ────────────────────────────────────────────────────── */}
      <div className="mt-3 flex items-center justify-center gap-1.5 text-center">
        <Sparkles className="size-3 text-[var(--color-faint)]" aria-hidden="true" />
        <p className="text-xs text-[var(--color-faint)]">
          {draft.engine === 'local-parser'
            ? t('voice.engineLocalParser')
            : 'Understood by Amazon Bedrock'}
        </p>
      </div>

      {/* ── Actions ───────────────────────────────────────────────────────── */}
      <div className="mt-5 space-y-2.5">
        {/*
          Stated before the button rather than after it. The shopkeeper is about
          to tell a customer what they are getting, and the fact that part of
          the order cannot be filled belongs in that moment, not in a toast
          afterwards.
        */}
        {unfulfilled > 0 ? (
          <div
            className="flex items-start gap-2 rounded-[var(--radius-field)] bg-[var(--color-warning-soft)] px-3.5 py-2.5"
            role="status"
          >
            <TriangleAlert
              className="mt-0.5 size-4 shrink-0 text-[var(--color-warning)]"
              aria-hidden="true"
            />
            <p className="text-xs font-semibold text-[var(--color-warning)]">
              {unfulfilled === 1
                ? '1 item could not be fulfilled from stock.'
                : `${unfulfilled} items could not be fulfilled from stock.`}{' '}
              <span className="font-medium">
                Only what is in stock is charged — the rest stays listed above.
              </span>
            </p>
          </div>
        ) : null}
        <Button
          size="lg"
          block
          loading={saving}
          disabled={!canSave}
          onClick={onConfirm}
          icon={<Check className="size-4" />}
          className="h-14 text-base shadow-[var(--shadow-lift)]"
        >
          {online ? `${t('voice.confirm')} · ${formatMoney(draft.total)}` : t('offline.notSavedYet')}
        </Button>

        {!canSave ? (
          <p className="text-center text-xs text-[var(--color-warning)]">
            {!haveCustomer
              ? t('voice.pickCustomer')
              : draft.items.length === 0
                ? 'Add at least one item to continue'
                : 'Nothing here is in stock — there is nothing to charge for'}
          </p>
        ) : null}

        <div className="grid grid-cols-2 gap-2.5">
          <Button
            variant="outline"
            size="md"
            onClick={() => setEditing((value) => !value)}
            icon={<Pencil className="size-4" />}
          >
            {editing ? t('common.done') : t('voice.edit')}
          </Button>
          <Button
            variant="outline"
            size="md"
            onClick={onSpeakAgain}
            icon={<RotateCcw className="size-4" />}
          >
            {t('voice.speakAgain')}
          </Button>
        </div>
      </div>

      {/* ── What was heard ────────────────────────────────────────────────── */}
      {draft.transcript ? (
        <div className="mt-6 flex gap-2.5 rounded-[var(--radius-card)] bg-[var(--color-sunken)] p-3.5">
          <Quote className="size-3.5 shrink-0 text-[var(--color-faint)]" aria-hidden="true" />
          <p className="text-sm leading-relaxed text-[var(--color-muted)] italic">
            {draft.transcript}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A money row with a proportional bar.
 *
 * The split between paid and pending is the thing a shopkeeper glances at, and
 * a bar communicates the ratio faster than two numbers do.
 */
function SplitRow({
  label,
  value,
  total,
  tone,
}: {
  label: string;
  value: number;
  total: number;
  tone: 'success' | 'warning';
}) {
  const share = total > 0 ? Math.max(2, (value / total) * 100) : 0;
  const colour = tone === 'success' ? 'var(--color-success)' : 'var(--color-warning)';

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-[var(--color-muted)]">{label}</span>
        <span className="text-base font-bold tabular" style={{ color: colour }}>
          {formatMoney(value)}
        </span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--color-line)]">
        <motion.div
          className="h-full rounded-full"
          style={{ backgroundColor: colour }}
          initial={{ width: 0 }}
          animate={{ width: `${share}%` }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        />
      </div>
    </div>
  );
}
