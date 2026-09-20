import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowRight,
  Boxes,
  CircleAlert,
  Info,
  Sparkles,
  TrendingUp,
  TriangleAlert,
  Truck,
  User,
  Wallet,
} from 'lucide-react';
import { useT } from '@/app/providers/I18nProvider';
import { cn } from '@/lib/cn';
import type { PulseCard, PulseKind, PulseSeverity } from '@shared/ai';

/**
 * A single priority card.
 *
 * Severity is carried by four independent channels — an icon shape, a colour
 * rail, a tinted surface, and a screen-reader label — so the urgency survives
 * colour-blindness and monochrome printing. Colour alone is never the signal.
 *
 * Critical and warning cards get a faint wash of their own colour so a glance
 * down the list sorts itself; info and positive cards stay on plain surface, so
 * the urgent ones actually stand out rather than everything shouting at once.
 */

const KIND_ICON: Record<PulseKind, typeof Boxes> = {
  stock: Boxes,
  payments: Wallet,
  orders: Truck,
  opportunity: TrendingUp,
  customer: User,
};

const SEVERITY: Record<
  PulseSeverity,
  {
    icon: typeof Info;
    chip: string;
    rail: string;
    wash: string;
    border: string;
    labelKey: string;
  }
> = {
  critical: {
    icon: CircleAlert,
    chip: 'bg-[var(--color-danger)] text-white',
    rail: 'bg-[var(--color-danger)]',
    wash: 'bg-[var(--color-danger)]/[0.04]',
    border: 'border-[var(--color-danger)]/25',
    labelKey: 'a11y.severityCritical',
  },
  warning: {
    icon: TriangleAlert,
    chip: 'bg-[var(--color-warning-soft)] text-[var(--color-warning)]',
    rail: 'bg-[var(--color-warning)]',
    wash: 'bg-[var(--color-warning)]/[0.035]',
    border: 'border-[var(--color-warning)]/25',
    labelKey: 'a11y.severityWarning',
  },
  info: {
    icon: Info,
    chip: 'bg-[var(--color-primary-soft)] text-[var(--color-primary)]',
    rail: 'bg-[var(--color-primary)]',
    wash: '',
    border: 'border-[var(--color-line)]',
    labelKey: 'a11y.severityInfo',
  },
  positive: {
    icon: Sparkles,
    chip: 'bg-[var(--color-success-soft)] text-[var(--color-success)]',
    rail: 'bg-[var(--color-success)]',
    wash: '',
    border: 'border-[var(--color-line)]',
    labelKey: 'a11y.severityPositive',
  },
};

export function PulseCardView({ card }: { card: PulseCard }) {
  const t = useT();
  const severity = SEVERITY[card.severity];
  const KindIcon = KIND_ICON[card.kind];
  const urgent = card.severity === 'critical' || card.severity === 'warning';

  return (
    <motion.div whileHover={{ y: -2 }} transition={{ type: 'spring', stiffness: 400, damping: 30 }}>
      <div
        className={cn(
          'lit group relative overflow-hidden rounded-[var(--radius-card)] border bg-[var(--color-surface)] transition-shadow hover:shadow-[var(--shadow-lift)]',
          severity.border,
        )}
      >
        {/* Colour wash, urgent cards only. */}
        {severity.wash ? (
          <span className={cn('absolute inset-0', severity.wash)} aria-hidden="true" />
        ) : null}

        {/* Rail on the leading edge. */}
        <span
          className={cn('absolute inset-y-0 left-0 w-1', severity.rail)}
          aria-hidden="true"
        />

        {/* A soft bloom in the card's own colour, surfacing on hover. Capped
            low, because the card's job is to be read, not to glow. */}
        <span
          className={cn(
            'pointer-events-none absolute -top-16 -right-16 size-40 rounded-full opacity-0 blur-3xl transition-opacity duration-500 group-hover:opacity-[0.12]',
            severity.rail,
          )}
          aria-hidden="true"
        />

        <div className="relative flex gap-4 p-4 pl-5 sm:p-5 sm:pl-6">
          <span
            className={cn(
              'flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-card)]',
              severity.chip,
            )}
          >
            <KindIcon className="size-5" aria-hidden="true" />
          </span>

          <div className="min-w-0 flex-1">
            {/* Severity announced as text, never implied by colour alone. */}
            <span className="sr-only">{t(severity.labelKey)}: </span>

            <h3
              className={cn(
                'leading-snug font-bold text-[var(--color-ink)]',
                urgent ? 'text-[1.0625rem]' : 'text-base',
              )}
            >
              {card.title}
            </h3>

            {card.body ? (
              <p className="mt-1 text-sm leading-snug text-[var(--color-muted)]">{card.body}</p>
            ) : null}

            {/* AI narration is visually distinct from the computed figures, so
                it is obvious which part a model wrote. */}
            {card.narration ? (
              <p className="mt-3 flex gap-2 rounded-[var(--radius-field)] border border-[var(--color-line)] bg-[var(--color-sunken)] px-3 py-2 text-sm leading-snug text-[var(--color-ink-soft)]">
                <Sparkles
                  className="mt-0.5 size-3.5 shrink-0 text-[var(--color-primary)]"
                  aria-hidden="true"
                />
                <span>{card.narration}</span>
              </p>
            ) : null}

            {card.actionLabel && card.actionHref ? (
              <Link
                to={card.actionHref}
                className="mt-3.5 inline-flex items-center gap-1.5 rounded-full bg-[var(--color-sunken)] px-3 py-1.5 text-sm font-semibold text-[var(--color-primary)] transition-colors hover:bg-[var(--color-primary-soft)]"
              >
                {card.actionLabel}
                <ArrowRight
                  className="size-3.5 transition-transform group-hover:translate-x-0.5"
                  aria-hidden="true"
                />
              </Link>
            ) : null}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
