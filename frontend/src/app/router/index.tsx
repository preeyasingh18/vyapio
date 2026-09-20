import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { TriangleAlert } from 'lucide-react';
import { useAuth } from '@/app/providers/AuthProvider';
import { AppShell } from '@/components/layout/AppShell';
import { useT } from '@/app/providers/I18nProvider';
import { Button } from '@/components/ui';
import { LogoMark } from '@/components/brand/Logo';

/**
 * Routing.
 *
 * Every screen below the shell is lazy-loaded: the landing page and sign-in are
 * what a first-time visitor downloads, and the scanner in particular drags in a
 * large decoding library that has no business being in the initial bundle.
 */

const LandingPage = lazy(() => import('@/features/marketing/LandingPage'));
const LoginPage = lazy(() => import('@/features/auth/LoginPage'));
const SignupPage = lazy(() => import('@/features/auth/SignupPage'));
const VerifyPage = lazy(() => import('@/features/auth/VerifyPage'));
const ForgotPasswordPage = lazy(() => import('@/features/auth/ForgotPasswordPage'));
const OnboardingPage = lazy(() => import('@/features/auth/OnboardingPage'));

const HomePage = lazy(() => import('@/features/dashboard/HomePage'));
const ScannerPage = lazy(() => import('@/features/scanner/ScannerPage'));
const CustomersPage = lazy(() => import('@/features/customers/CustomersPage'));
const CustomerDetailPage = lazy(() => import('@/features/customers/CustomerDetailPage'));
const SalesPage = lazy(() => import('@/features/transactions/SalesPage'));
const NewSalePage = lazy(() => import('@/features/transactions/NewSalePage'));
const VoicePage = lazy(() => import('@/features/voice/VoicePage'));
const InventoryPage = lazy(() => import('@/features/inventory/InventoryPage'));
const ProductDetailPage = lazy(() => import('@/features/inventory/ProductDetailPage'));
const OrdersPage = lazy(() => import('@/features/orders/OrdersPage'));
const PaymentsPage = lazy(() => import('@/features/payments/PaymentsPage'));
const PulsePage = lazy(() => import('@/features/shop-pulse/PulsePage'));
const MemoryPage = lazy(() => import('@/features/ai-memory/MemoryPage'));
const AgentPage = lazy(() => import('@/features/ai-agent/AgentPage'));
const ReportsPage = lazy(() => import('@/features/dashboard/ReportsPage'));
const SettingsPage = lazy(() => import('@/features/dashboard/SettingsPage'));

const CustomerHomePage = lazy(() => import('@/features/customer-app/CustomerHomePage'));
const CustomerShopPage = lazy(() => import('@/features/customer-app/CustomerShopPage'));

/** Full-screen loader used while a lazy chunk arrives. */
function RouteFallback() {
  const t = useT();
  return (
    <div className="flex min-h-dvh items-center justify-center bg-[var(--color-bg)]">
      <LogoMark size={56} pulse label={t('a11y.loading')} />
    </div>
  );
}

/**
 * Gate for shopkeeper routes.
 *
 * Redirects preserve the attempted path, so signing in lands the user where
 * they were headed rather than dumping them on the home screen.
 */
function RequireShopkeeper({ children }: { children: ReactNode }) {
  const { status, user, needsOnboarding } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <RouteFallback />;
  if (status === 'anonymous') {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  if (user?.role === 'CUSTOMER') return <Navigate to="/me" replace />;

  // Onboarding is not optional: without a shop there is nothing to show.
  if (needsOnboarding && location.pathname !== '/onboarding') {
    return <Navigate to="/onboarding" replace />;
  }

  return <AppShell>{children}</AppShell>;
}

function RequireCustomer({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <RouteFallback />;
  if (status === 'anonymous') {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  if (user?.role === 'SHOPKEEPER') return <Navigate to="/app" replace />;

  return <>{children}</>;
}

/** Sends an already-signed-in visitor past the marketing and auth pages. */
function RedirectIfAuthenticated({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();

  if (status === 'loading') return <RouteFallback />;
  if (status === 'authenticated') {
    return <Navigate to={user?.role === 'CUSTOMER' ? '/me' : '/app'} replace />;
  }
  return <>{children}</>;
}

function NotFound() {
  const t = useT();
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5 bg-[var(--color-bg)] px-6 text-center">
      <TriangleAlert className="size-12 text-[var(--color-warning)]" aria-hidden="true" />
      <div>
        <h1 className="text-xl font-bold text-[var(--color-ink)]">{t('errors.pageNotFound')}</h1>
        <p className="mt-1.5 text-sm text-[var(--color-muted)]">{t('errors.pageNotFoundBody')}</p>
      </div>
      <Button to="/">{t('errors.goHome')}</Button>
    </div>
  );
}

export function AppRouter() {
  const location = useLocation();

  return (
    <Suspense fallback={<RouteFallback />}>
      <AnimatePresence mode="wait">
        <Routes location={location} key={location.pathname}>
          {/* ── Public ──────────────────────────────────────────────────── */}
          <Route
            path="/"
            element={
              <RedirectIfAuthenticated>
                <LandingPage />
              </RedirectIfAuthenticated>
            }
          />
          <Route
            path="/login"
            element={
              <RedirectIfAuthenticated>
                <LoginPage />
              </RedirectIfAuthenticated>
            }
          />
          <Route
            path="/signup"
            element={
              <RedirectIfAuthenticated>
                <SignupPage />
              </RedirectIfAuthenticated>
            }
          />
          <Route path="/verify" element={<VerifyPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />

          {/* Onboarding sits outside the shell — it is a full-screen flow. */}
          <Route path="/onboarding" element={<OnboardingPage />} />

          {/* ── Shopkeeper ──────────────────────────────────────────────── */}
          <Route path="/app" element={<RequireShopkeeper><HomePage /></RequireShopkeeper>} />
          <Route path="/app/scan" element={<RequireShopkeeper><ScannerPage /></RequireShopkeeper>} />
          <Route path="/app/customers" element={<RequireShopkeeper><CustomersPage /></RequireShopkeeper>} />
          <Route path="/app/customers/:customerId" element={<RequireShopkeeper><CustomerDetailPage /></RequireShopkeeper>} />
          <Route path="/app/sales" element={<RequireShopkeeper><SalesPage /></RequireShopkeeper>} />
          <Route path="/app/sales/new" element={<RequireShopkeeper><NewSalePage /></RequireShopkeeper>} />
          <Route path="/app/voice" element={<RequireShopkeeper><VoicePage /></RequireShopkeeper>} />
          <Route path="/app/inventory" element={<RequireShopkeeper><InventoryPage /></RequireShopkeeper>} />
          <Route path="/app/inventory/:productId" element={<RequireShopkeeper><ProductDetailPage /></RequireShopkeeper>} />
          <Route path="/app/orders" element={<RequireShopkeeper><OrdersPage /></RequireShopkeeper>} />
          <Route path="/app/payments" element={<RequireShopkeeper><PaymentsPage /></RequireShopkeeper>} />
          <Route path="/app/pulse" element={<RequireShopkeeper><PulsePage /></RequireShopkeeper>} />
          <Route path="/app/memory" element={<RequireShopkeeper><MemoryPage /></RequireShopkeeper>} />
          <Route path="/app/assistant" element={<RequireShopkeeper><AgentPage /></RequireShopkeeper>} />
          <Route path="/app/reports" element={<RequireShopkeeper><ReportsPage /></RequireShopkeeper>} />
          <Route path="/app/settings" element={<RequireShopkeeper><SettingsPage /></RequireShopkeeper>} />

          {/* ── Customer app ────────────────────────────────────────────── */}
          <Route path="/me" element={<RequireCustomer><CustomerHomePage /></RequireCustomer>} />
          <Route
            path="/me/shops/:vendorId/:customerId"
            element={<RequireCustomer><CustomerShopPage /></RequireCustomer>}
          />

          <Route path="*" element={<NotFound />} />
        </Routes>
      </AnimatePresence>
    </Suspense>
  );
}
