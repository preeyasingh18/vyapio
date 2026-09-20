import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AuthLayout } from './AuthLayout';
import { Button, Input } from '@/components/ui';
import { useT } from '@/app/providers/I18nProvider';
import { useToast } from '@/app/providers/ToastProvider';
import { api, ApiError } from '@/lib/api';

/** Email verification. Only reached when Cognito is configured. */
export default function VerifyPage() {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();

  const email = (location.state as { email?: string } | null)?.email ?? '';
  const [code, setCode] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api.post('/auth/confirm', { email, code }, { anonymous: true });
      toast.success('Email verified', 'You can sign in now.');
      navigate('/login', { state: { email } });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : null);
    } finally {
      setLoading(false);
    }
  };

  const resend = async () => {
    setResending(true);
    try {
      await api.post('/auth/resend-code', { email }, { anonymous: true });
      toast.success('Code sent', 'Check your inbox again.');
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : t('errors.generic'));
    } finally {
      setResending(false);
    }
  };

  return (
    <AuthLayout
      title={t('auth.verifyTitle')}
      subtitle={email ? `${t('auth.verifySubtitle')} (${email})` : t('auth.verifySubtitle')}
      footer={
        <Link to="/login" className="font-semibold text-[var(--color-primary)] hover:underline">
          {t('auth.signInInstead')}
        </Link>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Input
          label={t('auth.verificationCode')}
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="123456"
          // Wide tracking makes a 6-digit code easy to read back from an email.
          className="text-center text-2xl tracking-[0.5em]"
          required
        />

        {error ? (
          <p
            className="rounded-[var(--radius-field)] bg-[var(--color-danger-soft)] px-3.5 py-3 text-sm text-[var(--color-danger)]"
            role="alert"
          >
            {error.message}
          </p>
        ) : null}

        <Button type="submit" size="lg" block loading={loading} disabled={code.length < 4}>
          {t('auth.verify')}
        </Button>

        <Button
          type="button"
          variant="ghost"
          size="md"
          block
          loading={resending}
          onClick={() => void resend()}
        >
          {t('auth.resendCode')}
        </Button>
      </form>
    </AuthLayout>
  );
}
