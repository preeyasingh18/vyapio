import type { ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Boxes,
  ChartNoAxesColumn,
  ClipboardList,
  House,
  Mic,
  Moon,
  ScanLine,
  Settings,
  Sun,
  Truck,
  Users,
  Wallet,
  Brain,
  Activity,
  ArrowUpRight,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { Logo, LogoMark } from '@/components/brand/Logo';
import { initials } from '@/lib/format';
import { useT } from '@/app/providers/I18nProvider';
import { useTheme } from '@/app/providers/ThemeProvider';
import { useAuth } from '@/app/providers/AuthProvider';
import { ConnectionBanner } from './ConnectionBanner';

/**
 * The application shell.
 *
 * Two navigations for two postures, not one responsive compromise:
 *
 *   Mobile  — five bottom tabs with a raised SCAN button between them, because
 *             scanning is the loop's entry point and belongs under the thumb.
 *   Desktop — a grouped sidebar. The grouping is the point: ten flat items all
 *             styled identically forces a read of every label. Four short
 *             labelled groups can be scanned by shape.
 */

type NavItem = {
  to: string;
  labelKey: string;
  icon: typeof House;
  end?: boolean;
};

type NavGroup = {
  /** Omitted for the first group — a label above "Home" is noise. */
  labelKey?: string;
  items: NavItem[];
};

const MOBILE_TABS: NavItem[] = [
  { to: '/app', labelKey: 'nav.home', icon: House, end: true },
  { to: '/app/customers', labelKey: 'nav.customers', icon: Users },
  { to: '/app/sales', labelKey: 'nav.sales', icon: ClipboardList },
  { to: '/app/inventory', labelKey: 'nav.stock', icon: Boxes },
];

const NAV_GROUPS: NavGroup[] = [
  {
    items: [
      { to: '/app', labelKey: 'nav.home', icon: House, end: true },
      { to: '/app/customers', labelKey: 'nav.customers', icon: Users },
      { to: '/app/sales', labelKey: 'nav.sales', icon: ClipboardList },
      { to: '/app/orders', labelKey: 'nav.orders', icon: Truck },
      { to: '/app/inventory', labelKey: 'nav.inventory', icon: Boxes },
    ],
  },
  {
    /**
     * Shop Memory sits here rather than under a heading of its own.
     *
     * A group label over a single row costs more than it explains — and what
     * the shopkeeper wants from Shop Memory is the same thing they want from
     * Shop Pulse and Reports: to find out something about their shop. That it
     * happens to use AI to answer is an implementation detail, not a category.
     *
     * The assistant is not listed at all: the Mitra card at the foot of the
     * sidebar opens it, and two rows to the same screen read as two features.
     */
    labelKey: 'nav.groupInsights',
    items: [
      { to: '/app/pulse', labelKey: 'nav.pulse', icon: Activity },
      { to: '/app/reports', labelKey: 'nav.reports', icon: ChartNoAxesColumn },
      { to: '/app/memory', labelKey: 'nav.memory', icon: Brain },
    ],
  },
  {
    labelKey: 'nav.groupFinance',
    items: [{ to: '/app/payments', labelKey: 'nav.payments', icon: Wallet }],
  },
];


export function AppShell({ children }: { children: ReactNode }) {
  const t = useT();
  const { vendor } = useAuth();
  const { resolved, toggle } = useTheme();
  const location = useLocation();

  return (
    <div className="min-h-dvh bg-[var(--color-bg)]">
      {/* ── Desktop sidebar ─────────────────────────────────────────────── */}
      {/*
        A dark plane, not a tinted background.
        Navigation reading as a separate surface from the work is what lets the
        eye return to the same edge every time; a sidebar a shade off the page
        has to be re-found on every glance.
      */}
      <aside
        className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col bg-[var(--color-plum)] lg:flex"
        aria-label={t('a11y.mainNavigation')}
      >
        <Link
          to="/app"
          className="flex items-center gap-2.5 px-4 py-5 transition-opacity hover:opacity-80"
        >
          <Logo size="md" tone="light" />
        </Link>

        <nav className="flex-1 overflow-y-auto px-2.5 pb-4">
          {NAV_GROUPS.map((group, index) => (
            <div key={group.labelKey ?? 'main'} className={cn(index > 0 && 'mt-5')}>
              {group.labelKey ? (
                <p className="mb-1.5 px-2.5 text-[10px] font-bold tracking-[0.12em] text-[var(--color-plum-muted)] uppercase">
                  {t(group.labelKey)}
                </p>
              ) : null}
              <div className="space-y-px">
                {group.items.map((item) => (
                  <SidebarLink key={item.to} item={item} label={t(item.labelKey)} />
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/*
          Mitra, given a door rather than only a nav row.
          The assistant is the part of the product a shopkeeper is least likely
          to go looking for, so it gets a card that says what it is for instead
          of a label that assumes they already know.
        */}
        <NavLink
          to="/app/assistant"
          className={({ isActive }) =>
            cn(
              'mx-2.5 mb-2 flex items-center gap-2.5 rounded-[var(--radius-card)] px-2.5 py-2.5 transition-colors',
              // It is the only way in from here now, so it carries the active
              // state the removed nav row used to.
              isActive ? 'bg-white/16 ring-1 ring-white/20' : 'bg-white/6 hover:bg-white/10',
            )
          }
        >
          <LogoMark size={26} tone="light" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12px] font-semibold text-[var(--color-plum-ink)]">
              {t('nav.mitraTitle')}
            </span>
            <span className="block truncate text-[11px] text-[var(--color-plum-muted)]">
              {t('nav.mitraHint')}
            </span>
          </span>
          <ArrowUpRight className="size-3.5 shrink-0 text-[var(--color-plum-muted)]" aria-hidden="true" />
        </NavLink>

        <div className="border-t border-white/10 p-2.5">
          <SidebarLink
            item={{ to: '/app/settings', labelKey: 'nav.settings', icon: Settings }}
            label={t('nav.settings')}
          />

          <button
            type="button"
            onClick={toggle}
            className="mt-px flex w-full items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 py-2 text-[13px] font-medium text-[var(--color-plum-muted)] transition-colors hover:bg-white/8 hover:text-[var(--color-plum-ink)]"
            aria-label={t('a11y.toggleTheme')}
          >
            {resolved === 'dark' ? (
              <Sun className="size-[17px]" aria-hidden="true" />
            ) : (
              <Moon className="size-[17px]" aria-hidden="true" />
            )}
            {t('nav.theme')}
          </button>

          {vendor ? (
            <Link
              to="/app/settings"
              className="mt-2 flex items-center gap-2.5 rounded-[var(--radius-card)] border border-white/10 bg-white/6 px-2.5 py-2 transition-colors hover:bg-white/10"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-primary)] text-[11px] font-bold text-white">
                {initials(vendor.shopName)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold text-[var(--color-plum-ink)]">
                  {vendor.shopName}
                </span>
                <span className="block truncate text-[11px] text-[var(--color-plum-muted)]">
                  {vendor.city}
                </span>
              </span>
            </Link>
          ) : null}
        </div>
      </aside>

      {/* ── Content ─────────────────────────────────────────────────────── */}
      <div className="lg:pl-60">
        <ConnectionBanner />
        <main className="pb-safe-nav lg:pb-10">{children}</main>
      </div>

      {/* ── Mobile bottom navigation ────────────────────────────────────── */}
      <nav
        className="glass fixed inset-x-0 bottom-0 z-40 border-t border-[var(--color-line)] pb-[env(safe-area-inset-bottom)] lg:hidden"
        aria-label={t('a11y.mainNavigation')}
      >
        <div className="mx-auto grid max-w-lg grid-cols-5 items-end px-2">
          {MOBILE_TABS.slice(0, 2).map((item) => (
            <TabLink key={item.to} item={item} label={t(item.labelKey)} />
          ))}

          {/* SCAN sits proud of the bar — the primary action of the whole app. */}
          <div className="flex justify-center">
            <Link
              to="/app/scan"
              className="-mt-5 flex size-14 flex-col items-center justify-center gap-0.5 rounded-[var(--radius-card)] bg-[var(--color-accent)] text-[var(--color-accent-ink)] shadow-[var(--shadow-lift)] transition-transform active:scale-95"
              aria-label={t('nav.scan')}
            >
              <ScanLine className="size-5" aria-hidden="true" />
              <span className="text-[9px] font-bold tracking-wide uppercase">{t('nav.scan')}</span>
            </Link>
          </div>

          {MOBILE_TABS.slice(2).map((item) => (
            <TabLink key={item.to} item={item} label={t(item.labelKey)} />
          ))}
        </div>
      </nav>

      <VoiceButton label={t('nav.voice')} hint={t('nav.voiceHint')} from={location.pathname} />

    </div>
  );
}

/**
 * The persistent voice control.
 *
 * Expands to reveal its label on hover and on keyboard focus — the icon alone
 * does not say what it does, and a control this prominent should not be a
 * guess. It stays clear of the bottom bar on mobile.
 */
function VoiceButton({ label, hint, from }: { label: string; hint: string; from: string }) {
  return (
    <Link
      to="/app/voice"
      state={{ from }}
      className={cn(
        'group fixed right-4 bottom-[calc(env(safe-area-inset-bottom)+5rem)] z-40 flex h-12 items-center gap-2 overflow-hidden rounded-[var(--radius-card)] pl-3.5',
        'border border-[var(--color-line)] bg-[var(--color-elevated)] text-[var(--color-primary)] shadow-[var(--shadow-card)]',
        'transition-[box-shadow,transform,padding] duration-200 hover:shadow-[var(--shadow-lift)] active:scale-95',
        'pr-3.5 hover:pr-4 focus-visible:pr-4 lg:right-8 lg:bottom-8',
      )}
      aria-label={`${label} — ${hint}`}
    >
      <Mic className="size-5 shrink-0" aria-hidden="true" />
      {/* Width transition rather than display, so it animates. */}
      <span className="max-w-0 overflow-hidden text-sm font-semibold whitespace-nowrap text-[var(--color-ink)] transition-[max-width] duration-200 group-hover:max-w-[12rem] group-focus-visible:max-w-[12rem]">
        {hint}
      </span>
    </Link>
  );
}

function SidebarLink({ item, label }: { item: NavItem; label: string }) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) =>
        cn(
          'relative flex items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 py-2 text-[13px] transition-colors',
          isActive
            ? 'font-semibold text-[var(--color-plum-ink)]'
            : 'font-medium text-[var(--color-plum-muted)] hover:bg-white/8 hover:text-[var(--color-plum-ink)]',
        )
      }
    >
      {({ isActive }) => (
        <>
          {/* A tinted ground rather than a raised card: at this density a
              shadow on every active row makes the column look restless. */}
          {isActive ? (
            <motion.span
              layoutId="sidebar-active"
              className="absolute inset-0 rounded-[var(--radius-control)] bg-white/12"
              transition={{ type: 'spring', stiffness: 400, damping: 34 }}
            />
          ) : null}

          <item.icon className="relative size-[17px] shrink-0" aria-hidden="true" />
          <span className="relative truncate">{label}</span>
        </>
      )}
    </NavLink>
  );
}

function TabLink({ item, label }: { item: NavItem; label: string }) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) =>
        cn(
          'flex flex-col items-center gap-1 py-2.5 transition-colors',
          isActive ? 'text-[var(--color-primary)]' : 'text-[var(--color-muted)]',
        )
      }
    >
      {({ isActive }) => (
        <>
          <span className="relative">
            <item.icon className="size-[22px]" aria-hidden="true" />
            <AnimatePresence>
              {isActive ? (
                <motion.span
                  initial={{ scale: 0, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0, opacity: 0 }}
                  className="absolute -top-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-[var(--color-primary)]"
                />
              ) : null}
            </AnimatePresence>
          </span>
          <span className="text-[10px] font-semibold">{label}</span>
        </>
      )}
    </NavLink>
  );
}
