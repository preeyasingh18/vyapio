import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthLayout } from './AuthLayout';
import { Button, Input } from '@/components/ui';
import { useT } from '@/app/providers/I18nProvider';
import { useToast } from '@/app/providers/ToastProvider';
import { api, ApiError } from '@/lib/api';

/**
 * Password reset.
 *
 * Two phases in one screen: request a code, then set a new password with it.
 * Keeping them together means the user never loses the code by navigating away
 * to find it.
 */
export default function ForgotPasswordPage() {
  const t = useT();
  const navigate = useNavigate();
  const toast = useToast();

  const [phase, setPhase] = useState<'request' | 'reset'>('request');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);

  const requestCode = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api.post('/auth/forgot-password', { email }, { anonymous: true });
      setPhase('reset');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : null);
    } finally {
      setLoading(false);
    }
  };

  const resetPassword = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api.post('/auth/reset-password', { email, code, password }, { anonymous: true });
      toast.success('Password updated', 'Sign in with your new password.');
      navigate('/login', { state: { email } });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout
      title={t('auth.resetPassword')}
      subtitle={t('auth.resetPasswordSubtitle')}
      footer={
        <Link to="/login" className="font-semibold text-[var(--color-primary)] hover:underline">
          {t('auth.signInInstead')}
        </Link>
      }
    >
      {phase === 'request' ? (
        <form onSubmit={requestCode} className="space-y-4" noValidate>
          <Input
            type="email"
            label={t('auth.email')}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            inputMode="email"
            required
          />

          {/* In local mode there is no mail provider, and the API says so
              plainly rather than pretending a code was sent. */}
          {error ? (
            <p
              className="rounded-[var(--radius-field)] bg-[var(--color-warning-soft)] px-3.5 py-3 text-sm text-[var(--color-warning)]"
              role="alert"
            >
              {error.message}
            </p>
          ) : null}

          <Button type="submit" size="lg" block loading={loading}>
            {t('auth.sendCode')}
          </Button>
        </form>
      ) : (
        <form onSubmit={resetPassword} className="space-y-4" noValidate>
          <Input
            label={t('auth.verificationCode')}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            className="text-center text-xl tracking-[0.4em]"
            required
          />

          <Input
            type="password"
            label={t('auth.password')}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            hint="At least 8 characters, with an uppercase letter and a number"
            required
            {...(error?.issueFor('password') ? { error: error.issueFor('password') } : {})}
          />

          {error && error.issues.length === 0 ? (
            <p
              className="rounded-[var(--radius-field)] bg-[var(--color-danger-soft)] px-3.5 py-3 text-sm text-[var(--color-danger)]"
              role="alert"
            >
              {error.message}
            </p>
          ) : null}

          <Button type="submit" size="lg" block loading={loading}>
            {t('auth.resetPassword')}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
