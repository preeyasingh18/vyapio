import { useState, type FormEvent } from 'react';
import { OpeningShop } from '@/components/brand/OpeningShop';
import { atLeast } from '@/lib/atLeast';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, Store } from 'lucide-react';
import { AuthLayout } from './AuthLayout';
import { Button, Input } from '@/components/ui';
import { useT } from '@/app/providers/I18nProvider';
import { useAuth } from '@/app/providers/AuthProvider';
import { ApiError } from '@/lib/api';
import { appConfig } from '@/app/config';

export default function LoginPage() {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const { login, demoLogin } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);

  // Return the user to wherever they were headed before the redirect.
  const destination = (location.state as { from?: string } | null)?.from ?? '/app';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await atLeast(login(email, password));
      navigate(destination, { replace: true });
    } catch (caught) {
      const apiError = caught instanceof ApiError ? caught : null;
      setError(apiError);
      setLoading(false);

      // An unverified account needs the code screen, not a red message.
      if (apiError?.status === 403) {
        navigate('/verify', { state: { email } });
      }
    }
  };

  const openDemo = async () => {
    setDemoLoading(true);
    setError(null);
    try {
      await atLeast(demoLogin());
      navigate('/app', { replace: true });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : null);
      setDemoLoading(false);
    }
  };

  return (
    <>
      <OpeningShop show={loading || demoLoading} />
    <AuthLayout
      title={t('auth.loginTitle')}
      subtitle={t('auth.loginSubtitle')}
      footer={
        <span className="text-[var(--color-muted)]">
          {t('auth.noAccount')}{' '}
          <Link to="/signup" className="font-semibold text-[var(--color-primary)] hover:underline">
            {t('auth.createOne')}
          </Link>
        </span>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Input
          type="email"
          name="email"
          label={t('auth.email')}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          inputMode="email"
          required
          {...(error?.issueFor('email') ? { error: error.issueFor('email') } : {})}
        />

        <Input
          type="password"
          name="password"
          label={t('auth.password')}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          required
          {...(error?.issueFor('password') ? { error: error.issueFor('password') } : {})}
        />

        {/* Non-field errors: wrong credentials, server down, offline. */}
        {error && error.issues.length === 0 ? (
          <p
            className="rounded-[var(--radius-field)] bg-[var(--color-danger-soft)] px-3.5 py-3 text-sm text-[var(--color-danger)]"
            role="alert"
          >
            {error.message}
          </p>
        ) : null}

        <div className="flex justify-end">
          <Link
            to="/forgot-password"
            className="text-sm font-medium text-[var(--color-muted)] hover:text-[var(--color-primary)]"
          >
            {t('auth.forgotPassword')}
          </Link>
        </div>

        <Button type="submit" size="lg" block loading={loading}>
          {t('auth.signIn')}
        </Button>
      </form>

      {appConfig.demoMode ? (
        <div className="mt-6 border-t border-[var(--color-line)] pt-5">
          <div className="flex items-start gap-3 rounded-[var(--radius-field)] bg-[var(--color-sunken)] p-3.5">
            <Store className="mt-0.5 size-5 shrink-0 text-[var(--color-accent)]" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-[var(--color-ink)]">{t('auth.demoTitle')}</p>
              <p className="mt-0.5 text-sm leading-snug text-[var(--color-muted)]">
                {t('auth.demoBody')}
              </p>
            </div>
          </div>

          <Button
            variant="outline"
            size="lg"
            block
            className="mt-3"
            loading={demoLoading}
            onClick={() => void openDemo()}
            icon={<ArrowRight className="size-4" />}
          >
            {t('auth.demoButton')}
          </Button>
        </div>
      ) : null}
    </AuthLayout>
    </>
  );
}
