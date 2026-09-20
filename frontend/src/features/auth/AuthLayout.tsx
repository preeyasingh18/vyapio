import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Logo } from '@/components/brand/Logo';
import { PageTransition } from '@/components/motion';
import { useT } from '@/app/providers/I18nProvider';
import { useTheme } from '@/app/providers/ThemeProvider';
import { Moon, Sun } from 'lucide-react';

/**
 * Shared frame for the auth screens.
 *
 * Single column and centred on every breakpoint. A split hero would push the
 * form below the fold on a 390px screen, which is the device most of these
 * shopkeepers will sign up on.
 */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const t = useT();
  const { resolved, toggle } = useTheme();

  return (
    <PageTransition className="relative flex min-h-dvh flex-col overflow-hidden bg-[var(--color-bg)]">
      {/* Mesh ground, so the form sits on something rather than on white. */}
      <div className="mesh pointer-events-none absolute inset-0 -z-10" aria-hidden="true" />

      <header className="relative flex items-center justify-between px-4 py-4 sm:px-6">
        <Link to="/" aria-label={t('brand.name')}>
          <Logo size="md" />
        </Link>

        <button
          type="button"
          onClick={toggle}
          className="rounded-[var(--radius-field)] p-2 text-[var(--color-muted)] transition-colors hover:bg-[var(--color-sunken)]"
          aria-label={t('a11y.toggleTheme')}
        >
          {resolved === 'dark' ? (
            <Sun className="size-5" aria-hidden="true" />
          ) : (
            <Moon className="size-5" aria-hidden="true" />
          )}
        </button>
      </header>

      <main className="relative flex flex-1 items-center justify-center px-4 py-6 sm:px-6">
        <div className="w-full max-w-md">
          <div className="mb-7 text-center">
            <h1 className="font-[family-name:var(--font-display)] text-4xl leading-[1.05] text-[var(--color-ink)] sm:text-5xl">
              {title}
            </h1>
            {subtitle ? (
              <p className="mt-2 text-sm text-[var(--color-muted)]">{subtitle}</p>
            ) : null}
          </div>

          <div className="lit rounded-[var(--radius-sheet)] border border-[var(--color-line)] bg-[var(--color-surface)]/85 p-5 shadow-[var(--shadow-lift)] backdrop-blur-xl sm:p-7">
            {children}
          </div>

          {footer ? <div className="mt-5 text-center text-sm">{footer}</div> : null}
        </div>
      </main>
    </PageTransition>
  );
}
