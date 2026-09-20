import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowUp, Moon, Package, ScanLine, Store, Sun } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Input, Sheet, Skeleton } from '@/components/ui';
import { LogoMark } from '@/components/brand/Logo';
import { Counter, PageTransition, Stagger, StaggerItem } from '@/components/motion';
import { useT } from '@/app/providers/I18nProvider';
import { useTheme } from '@/app/providers/ThemeProvider';
import { useAuth } from '@/app/providers/AuthProvider';
import { useToast } from '@/app/providers/ToastProvider';
import { useQuery } from '@/hooks/useApi';
import { api, ApiError } from '@/lib/api';
import { formatMoney, formatNumber } from '@/lib/format';
import type { MemoryAnswer } from '@shared/ai';

/**
 * The customer application.
 *
 * A different product with the same spine. A customer's question is "what do I
 * owe, and where?", so the home screen leads with the total across every shop
 * and then breaks it down — the inverse of the shopkeeper's single-shop view.
 */

type HomeResponse = {
  shops: Array<{
    vendorId: string;
    customerId: string;
    shopName: string;
    category: string;
    city: string;
    outstanding: number;
    transactionCount: number;
    spentThisMonth: number;
    readyOrders: number;
    lastVisitAt: string | null;
  }>;
  summary: {
    shopCount: number;
    transactionCount: number;
    pending: number;
    spentThisMonth: number;
    readyOrders: number;
  };
  message?: string;
};

export default function CustomerHomePage() {
  const t = useT();
  const { resolved, toggle } = useTheme();
  const { logout } = useAuth();
  const navigate = useNavigate();

  const [linkOpen, setLinkOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);

  const { data, loading, refetch } = useQuery<HomeResponse>('/me/home');

  const hour = new Date().getHours();
  const greeting =
    hour < 12 ? t('home.greetingMorning') : hour < 17 ? t('home.greetingAfternoon') : t('home.greetingEvening');

  return (
    <PageTransition className="min-h-dvh bg-[var(--color-bg)]">
      <header className="warm-glow border-b border-[var(--color-line)]">
        <div className="mx-auto max-w-2xl px-4 pt-[calc(env(safe-area-inset-top)+1.25rem)] pb-6 sm:px-6">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm text-[var(--color-muted)]">{greeting} 👋</p>
              <h1 className="mt-0.5 text-2xl font-extrabold tracking-tight text-[var(--color-ink)]">
                {t('customerApp.title')}
              </h1>
            </div>

            <div className="flex gap-1">
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
            </div>
          </div>

          {/* The headline number: everything owed, everywhere. */}
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile
              label={t('customerApp.myShops')}
              value={data?.summary.shopCount ?? 0}
              format={(value) => formatNumber(value)}
            />
            <Tile
              label={t('customerApp.transactions')}
              value={data?.summary.transactionCount ?? 0}
              format={(value) => formatNumber(value)}
            />
            <Tile
              label={t('customerApp.pending')}
              value={data?.summary.pending ?? 0}
              format={formatMoney}
              tone={data && data.summary.pending > 0 ? 'warning' : undefined}
            />
            <Tile
              label={t('customerApp.spentThisMonth')}
              value={data?.summary.spentThisMonth ?? 0}
              format={formatMoney}
            />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-6 pb-28 sm:px-6">
        {loading && !data ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-20" />
            ))}
          </div>
        ) : (data?.shops.length ?? 0) === 0 ? (
          <EmptyState
            icon={<Store className="size-6" />}
            title={t('customerApp.noShops')}
            body={t('customerApp.noShopsBody')}
            action={
              <Button onClick={() => setLinkOpen(true)} icon={<ScanLine className="size-4" />}>
                {t('customerApp.linkShop')}
              </Button>
            }
          />
        ) : (
          <>
            <h2 className="mb-3 text-sm font-bold tracking-wide text-[var(--color-muted)] uppercase">
              {t('customerApp.myShops')}
            </h2>

            <Stagger className="space-y-2">
              {data!.shops.map((shop) => (
                <StaggerItem key={`${shop.vendorId}-${shop.customerId}`}>
                  <Link to={`/me/shops/${shop.vendorId}/${shop.customerId}`}>
                    <Card className="p-4 transition-transform active:scale-[0.995]">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-bold text-[var(--color-ink)]">
                            {shop.shopName}
                          </p>
                          <p className="mt-0.5 truncate text-xs text-[var(--color-muted)]">
                            {shop.city} · {shop.transactionCount} purchases
                          </p>
                        </div>

                        <div className="shrink-0 text-right">
                          {shop.outstanding > 0 ? (
                            <Badge tone="warning">
                              {formatMoney(shop.outstanding)} {t('customerApp.pending').toLowerCase()}
                            </Badge>
                          ) : (
                            <Badge tone="success">{formatMoney(0)} pending</Badge>
                          )}

                          {shop.readyOrders > 0 ? (
                            <p className="mt-1.5 flex items-center justify-end gap-1 text-xs font-semibold text-[var(--color-success)]">
                              <Package className="size-3.5" aria-hidden="true" />
                              {shop.readyOrders}{' '}
                              {shop.readyOrders === 1
                                ? t('customerApp.orderReady')
                                : t('customerApp.ordersReady')}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    </Card>
                  </Link>
                </StaggerItem>
              ))}
            </Stagger>

            <Button
              variant="outline"
              size="lg"
              block
              className="mt-4"
              onClick={() => setLinkOpen(true)}
              icon={<ScanLine className="size-4" />}
            >
              {t('customerApp.linkShop')}
            </Button>
          </>
        )}

        <button
          type="button"
          onClick={() => void logout().then(() => navigate('/'))}
          className="mx-auto mt-8 block text-sm font-medium text-[var(--color-muted)] hover:text-[var(--color-ink)]"
        >
          {t('nav.signOut')}
        </button>
      </main>

      {/* Ask, for the customer's own records. */}
      <button
        type="button"
        onClick={() => setAskOpen(true)}
        className="fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom)+1rem)] z-30 mx-auto flex max-w-2xl items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-elevated)] px-4 py-3.5 text-left shadow-[var(--shadow-lift)] sm:inset-x-6"
      >
        <LogoMark size={26} />
        <span className="flex-1 text-sm text-[var(--color-muted)]">
          {t('customerApp.askPlaceholder')}
        </span>
      </button>

      <LinkShopSheet open={linkOpen} onClose={() => setLinkOpen(false)} onLinked={() => void refetch()} />
      <AskSheet open={askOpen} onClose={() => setAskOpen(false)} />
    </PageTransition>
  );
}

function Tile({
  label,
  value,
  format,
  tone,
}: {
  label: string;
  value: number;
  format: (value: number) => string;
  tone?: 'warning';
}) {
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-3.5">
      <p className="text-[10px] font-semibold tracking-wide text-[var(--color-muted)] uppercase">
        {label}
      </p>
      <p
        className={`mt-1 text-xl font-extrabold ${
          tone === 'warning' ? 'text-[var(--color-warning)]' : 'text-[var(--color-ink)]'
        }`}
      >
        <Counter value={value} format={format} />
      </p>
    </div>
  );
}

/**
 * Linking a shop.
 *
 * Proof of ownership is possession of the printed card's token — the same trust
 * model as handing over a loyalty card, and nothing is revealed until the
 * holder is authenticated.
 */
function LinkShopSheet({
  open,
  onClose,
  onLinked,
}: {
  open: boolean;
  onClose: () => void;
  onLinked: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!code.trim()) return;
    setBusy(true);
    try {
      const result = await api.post<{ shopName: string }>('/auth/claim-profile', {
        qrId: code.trim(),
      });
      toast.success('Shop linked', result.shopName);
      setCode('');
      onClose();
      onLinked();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : t('errors.generic'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('customerApp.linkShop')}
      description="Enter the code printed on your Vyapio card."
      footer={
        <Button size="lg" block loading={busy} disabled={!code.trim()} onClick={() => void submit()}>
          {t('customerApp.linkShop')}
        </Button>
      }
    >
      <Input
        value={code}
        onChange={(event) => setCode(event.target.value)}
        placeholder="vq_..."
        autoFocus
        className="font-mono"
      />
    </Sheet>
  );
}

function AskSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<MemoryAnswer | null>(null);
  const [busy, setBusy] = useState(false);

  const suggestions = [
    'How much do I owe across shops?',
    'What did I spend this month?',
    'When did I last buy detergent?',
  ];

  const ask = async (text: string) => {
    if (!text.trim()) return;
    setBusy(true);
    setAnswer(null);
    try {
      const result = await api.post<{ result: MemoryAnswer }>('/me/ask', { question: text.trim() });
      setAnswer(result.result);
    } catch {
      setAnswer(null);
    } finally {
      setBusy(false);
      setQuestion('');
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title={t('memory.title')}>
      <div className="pb-2">
        {answer ? (
          <Card
            className={answer.grounded ? 'p-4' : 'border-[var(--color-warning)] p-4'}
          >
            <p className="text-sm leading-relaxed whitespace-pre-line text-[var(--color-ink)]">
              {answer.answer}
            </p>
          </Card>
        ) : busy ? (
          <div className="flex flex-col items-center py-8">
            <LogoMark size={56} pulse />
            <p className="mt-3 text-sm text-[var(--color-muted)]">{t('memory.thinking')}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => void ask(suggestion)}
                className="w-full rounded-[var(--radius-field)] border border-[var(--color-line)] p-3 text-left text-sm text-[var(--color-ink-soft)] transition-colors active:bg-[var(--color-sunken)]"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}

        <form
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void ask(question);
          }}
          className="mt-4 flex gap-2"
        >
          <Input
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder={t('customerApp.askPlaceholder')}
            disabled={busy}
          />
          <Button
            type="submit"
            size="icon"
            className="size-12 shrink-0"
            disabled={!question.trim() || busy}
            aria-label={t('memory.ask')}
          >
            <ArrowUp className="size-5" aria-hidden="true" />
          </Button>
        </form>
      </div>
    </Sheet>
  );
}
