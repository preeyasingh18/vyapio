import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  Brain,
  ChartNoAxesColumn,
  Ellipsis,
  Moon,
  Settings,
  Sparkles,
  Sun,
  Truck,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { Sheet } from '@/components/ui';
import { useT } from '@/app/providers/I18nProvider';
import { useTheme } from '@/app/providers/ThemeProvider';
import { cn } from '@/lib/cn';

/**
 * Everything the five bottom tabs could not hold, on small screens.
 *
 * It owns its own open state and its own sheet, so it can be dropped into any
 * header without threading state up to the shell. That matters because it has
 * to appear on *every* mobile screen: it is the only way to Orders, Reports,
 * Payments and Settings from a phone, and a page that forgets to render it is a
 * page you cannot navigate away from except by going back.
 *
 * It used to sit in the bottom bar as a sixth item in a five-column grid, which
 * wrapped it onto a second row of its own underneath.
 */

type MoreItem = { to: string; labelKey: string; icon: LucideIcon };

const MORE_ITEMS: MoreItem[] = [
  { to: '/app/orders', labelKey: 'nav.orders', icon: Truck },
  { to: '/app/pulse', labelKey: 'nav.pulse', icon: Activity },
  { to: '/app/assistant', labelKey: 'nav.assistant', icon: Sparkles },
  { to: '/app/memory', labelKey: 'nav.memory', icon: Brain },
  { to: '/app/payments', labelKey: 'nav.payments', icon: Wallet },
  { to: '/app/reports', labelKey: 'nav.reports', icon: ChartNoAxesColumn },
  { to: '/app/settings', labelKey: 'nav.settings', icon: Settings },
];

export function MoreMenu({ className }: { className?: string }) {
  const t = useT();
  const { resolved, toggle } = useTheme();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('nav.more')}
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] border border-[var(--color-line)] text-[var(--color-muted)] transition-colors active:bg-[var(--color-sunken)] lg:hidden',
          className,
        )}
      >
        <Ellipsis className="size-[18px]" aria-hidden="true" />
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} title={t('nav.more')}>
        <div className="grid grid-cols-2 gap-2 pb-2">
          {MORE_ITEMS.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              onClick={() => setOpen(false)}
              className="flex items-center gap-2.5 rounded-[var(--radius-field)] border border-[var(--color-line)] bg-[var(--color-surface)] p-3 transition-colors active:bg-[var(--color-sunken)]"
            >
              <item.icon className="size-[18px] text-[var(--color-primary)]" aria-hidden="true" />
              <span className="text-sm font-semibold text-[var(--color-ink)]">
                {t(item.labelKey)}
              </span>
            </Link>
          ))}
        </div>

        <div className="mt-2 border-t border-[var(--color-line)] pt-3">
          <button
            type="button"
            onClick={toggle}
            className="flex w-full items-center gap-2.5 rounded-[var(--radius-field)] p-3 text-left transition-colors active:bg-[var(--color-sunken)]"
          >
            {resolved === 'dark' ? (
              <Sun className="size-[18px] text-[var(--color-muted)]" aria-hidden="true" />
            ) : (
              <Moon className="size-[18px] text-[var(--color-muted)]" aria-hidden="true" />
            )}
            <span className="text-sm font-medium text-[var(--color-ink)]">{t('nav.theme')}</span>
          </button>
        </div>
      </Sheet>
    </>
  );
}
