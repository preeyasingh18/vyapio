import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AuthLayout } from './AuthLayout';
import { Button } from '@/components/ui';
import { useT } from '@/app/providers/I18nProvider';
import { useToast } from '@/app/providers/ToastProvider';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';

/**
 * The code that turns a signup into an account.
 *
 * Nothing exists until this screen is finished: the form's answers are parked
 * on the server and the User and Vendor rows are written when the code comes
 * back. So the two things this has to get right are that the code is easy to
 * enter, and that it is always clear what to do when it does not arrive.
 */

const LENGTH = 6;

/** How long the code is good for, matching OTP_TTL_MINUTES on the server. */
const EXPIRES_IN_SECONDS = 10 * 60;

/** Matches RESEND_COOLDOWN_SECONDS. The server enforces it; this explains it. */
const RESEND_COOLDOWN = 60;

export default function VerifyPage() {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();

  const email = (location.state as { email?: string } | null)?.email ?? '';

  const [digits, setDigits] = useState<string[]>(Array(LENGTH).fill(''));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [expiresIn, setExpiresIn] = useState(EXPIRES_IN_SECONDS);
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN);

  const boxes = useRef<Array<HTMLInputElement | null>>([]);
  const code = digits.join('');
  const complete = code.length === LENGTH;

  /**
   * Two countdowns on one interval.
   *
   * Both are only ever read as "how long is left", so a second timer would be
   * a second thing to keep in step for no gain.
   */
  useEffect(() => {
    const tick = setInterval(() => {
      setExpiresIn((left) => Math.max(0, left - 1));
      setCooldown((left) => Math.max(0, left - 1));
    }, 1000);
    return () => clearInterval(tick);
  }, []);

  const expired = expiresIn === 0;

  const put = (index: number, value: string) => {
    setError(null);
    setDigits((current) => {
      const next = [...current];
      next[index] = value;
      return next;
    });
  };

  const onChange = (index: number, raw: string) => {
    const value = raw.replace(/\D/g, '');
    if (!value) {
      put(index, '');
      return;
    }

    /**
     * More than one digit means a paste, or a keyboard that batches input.
     * Spreading it across the boxes is the only behaviour that is not
     * surprising — dropping all but the first is what feels broken.
     */
    if (value.length > 1) {
      fill(value, index);
      return;
    }

    put(index, value);
    if (index < LENGTH - 1) boxes.current[index + 1]?.focus();
  };

  const fill = (value: string, from = 0) => {
    const incoming = value.replace(/\D/g, '').slice(0, LENGTH - from).split('');
    setError(null);
    setDigits((current) => {
      const next = [...current];
      incoming.forEach((digit, offset) => {
        next[from + offset] = digit;
      });
      return next;
    });
    const landed = Math.min(from + incoming.length, LENGTH - 1);
    boxes.current[landed]?.focus();
  };

  const onKeyDown = (index: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace' && !digits[index] && index > 0) {
      // Deleting through an empty box moves back, rather than doing nothing.
      event.preventDefault();
      put(index - 1, '');
      boxes.current[index - 1]?.focus();
    }
    if (event.key === 'ArrowLeft' && index > 0) boxes.current[index - 1]?.focus();
    if (event.key === 'ArrowRight' && index < LENGTH - 1) boxes.current[index + 1]?.focus();
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData('text');
    if (!/\d/.test(pasted)) return;
    event.preventDefault();
    fill(pasted);
  };

  const verify = async () => {
    if (!complete || loading) return;
    setLoading(true);
    setError(null);
    try {
      await api.post('/auth/confirm', { email, code }, { anonymous: true });
      toast.success(t('auth.emailVerified'), t('auth.accountCreated'));
      navigate('/login', { state: { email } });
    } catch (caught) {
      // The server's message says which of the several failures this is —
      // wrong, expired, or too many tries — and each needs a different move.
      setError(caught instanceof ApiError ? caught.message : t('errors.generic'));
      setDigits(Array(LENGTH).fill(''));
      boxes.current[0]?.focus();
    } finally {
      setLoading(false);
    }
  };

  const resend = async () => {
    if (cooldown > 0 || resending) return;
    setResending(true);
    setError(null);
    try {
      await api.post('/auth/resend-code', { email }, { anonymous: true });
      toast.success(t('auth.codeSent'), maskEmail(email));
      setDigits(Array(LENGTH).fill(''));
      setExpiresIn(EXPIRES_IN_SECONDS);
      setCooldown(RESEND_COOLDOWN);
      boxes.current[0]?.focus();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('errors.generic'));
    } finally {
      setResending(false);
    }
  };

  // Landing here without an address means the signup state was lost — a
  // reload, or a link opened on its own. There is nothing to verify.
  if (!email) {
    return (
      <AuthLayout title={t('auth.verifyTitle')} subtitle={t('auth.verifyLost')}>
        <Button to="/signup" size="lg" block>
          {t('auth.backToSignup')}
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={t('auth.verifyTitle')}
      subtitle={`${t('auth.verifySentTo')} ${maskEmail(email)}`}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void verify();
        }}
        className="space-y-5"
        noValidate
      >
        <div>
          <div className="flex justify-between gap-2" role="group" aria-label={t('auth.code')}>
            {digits.map((digit, index) => (
              <input
                key={index}
                ref={(element) => {
                  boxes.current[index] = element;
                }}
                type="text"
                inputMode="numeric"
                // Lets a phone offer the code straight from the SMS or email.
                autoComplete={index === 0 ? 'one-time-code' : 'off'}
                maxLength={1}
                value={digit}
                autoFocus={index === 0}
                aria-label={`${t('auth.code')} ${index + 1}`}
                onChange={(event) => onChange(index, event.target.value)}
                onKeyDown={(event) => onKeyDown(index, event)}
                onPaste={onPaste}
                onFocus={(event) => event.target.select()}
                className={cn(
                  'h-14 w-full min-w-0 rounded-[var(--radius-field)] border bg-[var(--color-surface)] text-center text-xl font-bold text-[var(--color-ink)] tabular transition-colors',
                  'focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary)]/25 focus:outline-none',
                  error ? 'border-[var(--color-danger)]' : 'border-[var(--color-line)]',
                )}
              />
            ))}
          </div>

          {error ? (
            <p className="mt-2 text-sm text-[var(--color-danger)]" role="alert">
              {error}
            </p>
          ) : (
            <p className="mt-2 text-xs text-[var(--color-muted)]">
              {expired ? t('auth.codeExpired') : `${t('auth.expiresIn')} ${clock(expiresIn)}`}
            </p>
          )}
        </div>

        <Button type="submit" size="lg" block loading={loading} disabled={!complete || expired}>
          {t('auth.verifyEmail')}
        </Button>

        <div className="flex items-center justify-between gap-3 text-sm">
          <button
            type="button"
            onClick={() => void resend()}
            disabled={cooldown > 0 || resending}
            className="font-semibold text-[var(--color-primary)] hover:underline disabled:text-[var(--color-faint)] disabled:no-underline"
          >
            {cooldown > 0
              ? `${t('auth.resendIn')} ${cooldown}s`
              : resending
                ? t('auth.sending')
                : t('auth.resendCode')}
          </button>

          {/* A typo in the address is the likeliest reason nothing arrived,
              and there is no way back to it from here otherwise. */}
          <Link
            to="/signup"
            state={{ email }}
            className="text-[var(--color-muted)] hover:text-[var(--color-ink)] hover:underline"
          >
            ← {t('auth.changeEmail')}
          </Link>
        </div>
      </form>
    </AuthLayout>
  );
}

/** "09:42" — a countdown reads faster than "562 seconds left". */
function clock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * "a***a@gmail.com".
 *
 * Enough to recognise your own address, not enough to read out a stranger's if
 * this screen is left open on a shared counter.
 */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return email;
  if (local.length <= 2) return `${local[0]}***@${domain}`;
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}
