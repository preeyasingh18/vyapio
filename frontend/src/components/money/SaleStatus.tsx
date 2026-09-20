import { StatusBadge } from '@/components/ui';
import { useT, useI18n } from '@/app/providers/I18nProvider';
import { formatMoney, formatTime, formatTimelineDate } from '@/lib/format';
import type { Settlement } from '@shared/entities';

/**
 * Where a sale stands right now.
 *
 * One component because this appears on the sales list, the dashboard, a
 * customer's history and the customer's own app, and those four screens
 * disagreeing about whether a bill is paid is worse than any one of them being
 * wrong: the shopkeeper cannot tell which to believe.
 *
 * It renders `pending`, never `Transaction.outstanding`. The latter is frozen
 * at the moment of sale and answers "what was left that day" — showing it as a
 * live balance had shopkeepers chasing customers who had already settled up.
 *
 * When money has come in, the time it arrived sits beside the status, because
 * "paid" without a date is a claim the shopkeeper has no way to check against
 * what the customer remembers.
 */

type Props = Settlement & {
  /** The sale's full amount, to work out how much of it has been paid. */
  total: number;
  /** `badge` for table rows, `plain` for cards where a pill is too heavy. */
  variant?: 'badge' | 'plain';
  className?: string;
};

export function SaleStatus({ pending, paidAt, total, variant = 'badge', className }: Props) {
  const t = useT();
  const { locale } = useI18n();

  const settled = pending <= 0;
  const when = paidAt ? `${formatTimelineDate(paidAt, locale)} · ${formatTime(paidAt, locale)}` : '';

  /**
   * A part-paid bill shows what has already come in. The amount is worth more
   * than the word alone — "₹340 paid" tells the shopkeeper what to ask for,
   * and it is the difference the customer will argue about.
   */
  const note = settled
    ? when
    : paidAt
      ? `${formatMoney(total - pending)} ${t('common.partPaid')} · ${when}`
      : '';

  return (
    <span className={className}>
      {variant === 'badge' ? (
        <StatusBadge tone={settled ? 'success' : 'warning'}>
          {settled ? t('common.paid') : `${formatMoney(pending)} ${t('home.pendingWord')}`}
        </StatusBadge>
      ) : (
        <span
          className={
            settled
              ? 'text-xs text-[var(--color-success)]'
              : 'text-xs font-semibold text-[var(--color-warning)] tabular'
          }
        >
          {settled ? t('common.paid') : `${formatMoney(pending)} ${t('home.pendingWord')}`}
        </span>
      )}

      {note ? (
        <span className="mt-0.5 block text-[11px] whitespace-nowrap text-[var(--color-faint)]">
          {note}
        </span>
      ) : null}
    </span>
  );
}
