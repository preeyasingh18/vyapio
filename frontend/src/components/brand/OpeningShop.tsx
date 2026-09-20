import { motion, useReducedMotion } from 'framer-motion';
import { LogoMark } from '@/components/brand/Logo';
import { useT } from '@/app/providers/I18nProvider';

/**
 * The moment between tapping "enter" and the shop appearing.
 *
 * Signing in, fetching the shop and loading the dashboard is several requests,
 * and on a phone on a shop's connection it is long enough that a button which
 * merely dims looks broken. This says what is happening and whose shop it is.
 *
 * It covers the screen deliberately: a spinner inside the button leaves the
 * old page sitting there, and the shopkeeper taps again.
 */
export function OpeningShop({ show }: { show: boolean }) {
  const t = useT();
  const reduceMotion = useReducedMotion();

  if (!show) return null;

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-5 bg-[var(--color-bg)]"
      role="status"
      aria-live="polite"
    >
      <LogoMark size={56} pulse={!reduceMotion} />

      <p className="text-sm font-semibold text-[var(--color-muted)]">{t('auth.openingShop')}</p>
    </motion.div>
  );
}
