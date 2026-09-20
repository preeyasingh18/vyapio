import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Minus, Plus, Sparkles, TrendingUp } from 'lucide-react';
import { PageBody, PageHeader, SectionHeading } from '@/components/layout/PageHeader';
import { Badge, Button, Card, EmptyState, Input, Select, Sheet, Skeleton } from '@/components/ui';
import { PageTransition } from '@/components/motion';
import { useT, useI18n } from '@/app/providers/I18nProvider';
import { useToast } from '@/app/providers/ToastProvider';
import { useQuery } from '@/hooks/useApi';
import { api, ApiError } from '@/lib/api';
import { formatMoney, formatTimelineDate } from '@/lib/format';
import { INVENTORY_EVENT_TYPES, type InventoryEvent, type InventoryEventType, type Product } from '@shared/entities';

type ProductResponse = {
  product: Product;
  insight: {
    soldInWindow: number;
    soldThisWeek: number;
    salesVelocity: number;
    daysRemaining: number | null;
    lowStock: boolean;
    outOfStock: boolean;
    belowReorderLevel: boolean;
    marginPercent: number;
    revenueInWindow: number;
    profitInWindow: number;
    suggestedRestockQuantity: number;
  };
  explanation: string;
  explanationEngine: 'bedrock' | 'deterministic';
  events: InventoryEvent[];
};

export default function ProductDetailPage() {
  const t = useT();
  const { locale } = useI18n();
  const { productId } = useParams<{ productId: string }>();
  const [adjustOpen, setAdjustOpen] = useState(false);

  const { data, loading, error, refetch } = useQuery<ProductResponse>(
    productId ? `/inventory/${productId}` : null,
  );

  if (loading && !data) {
    return (
      <PageTransition>
        <PageHeader title={t('common.loading')} back />
        <PageBody>
          <Skeleton className="h-40" />
          <Skeleton className="mt-4 h-32" />
        </PageBody>
      </PageTransition>
    );
  }

  if (error || !data) {
    return (
      <PageTransition>
        <PageHeader title={t('errors.notFound')} back />
        <PageBody>
          <EmptyState
            title={error?.message ?? t('errors.notFound')}
            action={
              <Button variant="outline" onClick={() => void refetch()}>
                {t('common.retry')}
              </Button>
            }
          />
        </PageBody>
      </PageTransition>
    );
  }

  const { product, insight } = data;

  return (
    <PageTransition>
      <PageHeader title={product.name} subtitle={product.category} back />

      <PageBody>
        {/* Headline: stock and how long it lasts, side by side. */}
        <Card className="p-5">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-4xl font-extrabold text-[var(--color-ink)] tabular">
                {product.stock}
              </p>
              <p className="mt-0.5 text-sm text-[var(--color-muted)]">
                {product.unit} {t('inventory.inStock')}
              </p>
            </div>

            <div className="text-right">
              {insight.outOfStock ? (
                <Badge tone="danger">{t('inventory.outOfStock')}</Badge>
              ) : insight.daysRemaining !== null ? (
                <>
                  <p
                    className={`text-2xl font-extrabold tabular ${
                      insight.daysRemaining <= 3
                        ? 'text-[var(--color-danger)]'
                        : insight.daysRemaining <= 7
                          ? 'text-[var(--color-warning)]'
                          : 'text-[var(--color-success)]'
                    }`}
                  >
                    ~{Math.round(insight.daysRemaining)}
                  </p>
                  <p className="text-sm text-[var(--color-muted)]">{t('inventory.daysRemaining')}</p>
                </>
              ) : (
                <p className="max-w-[10rem] text-sm text-[var(--color-muted)]">
                  {t('inventory.daysRemainingNone')}
                </p>
              )}
            </div>
          </div>

          {/* The explanation. Labelled by engine so a deterministic sentence is
              never passed off as an AI insight. */}
          <div className="mt-5 flex gap-2.5 rounded-[var(--radius-field)] bg-[var(--color-sunken)] p-3.5">
            <Sparkles
              className="mt-0.5 size-4 shrink-0 text-[var(--color-primary)]"
              aria-hidden="true"
            />
            <div>
              <p className="text-sm leading-snug text-[var(--color-ink-soft)]">{data.explanation}</p>
              <p className="mt-1 text-[11px] text-[var(--color-faint)]">
                {data.explanationEngine === 'bedrock'
                  ? t('pulse.narratedBy')
                  : t('pulse.generatedBy')}
              </p>
            </div>
          </div>
        </Card>

        {/* Deterministic figures. */}
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric
            label={t('inventory.soldThisWeek')}
            value={`${insight.soldThisWeek} ${product.unit}`}
          />
          <Metric
            label="Velocity"
            value={`${insight.salesVelocity}${t('inventory.perDay')}`}
          />
          <Metric label={t('inventory.margin')} value={`${insight.marginPercent}%`} />
          <Metric label="14-day profit" value={formatMoney(insight.profitInWindow)} tone="success" />
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <Card className="p-4">
            <p className="text-xs font-semibold tracking-wide text-[var(--color-muted)] uppercase">
              {t('inventory.costPrice')}
            </p>
            <p className="mt-1 text-lg font-bold text-[var(--color-ink)] tabular">
              {formatMoney(product.costPrice)}
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-xs font-semibold tracking-wide text-[var(--color-muted)] uppercase">
              {t('inventory.sellingPrice')}
            </p>
            <p className="mt-1 text-lg font-bold text-[var(--color-ink)] tabular">
              {formatMoney(product.sellingPrice)}
            </p>
          </Card>
        </div>

        {insight.suggestedRestockQuantity > 0 ? (
          <Card className="mt-4 border-[var(--color-primary)] p-4">
            <div className="flex items-center gap-3">
              <TrendingUp className="size-5 shrink-0 text-[var(--color-primary)]" aria-hidden="true" />
              <div className="flex-1">
                <p className="text-sm font-bold text-[var(--color-ink)]">
                  {t('inventory.suggestedQuantity')}: {insight.suggestedRestockQuantity}{' '}
                  {product.unit}
                </p>
                <p className="text-xs text-[var(--color-muted)]">
                  {t('inventory.estimatedCost')}{' '}
                  {formatMoney(insight.suggestedRestockQuantity * product.costPrice)} · restores two
                  weeks of cover
                </p>
              </div>
            </div>
          </Card>
        ) : null}

        <Button
          size="lg"
          block
          variant="outline"
          className="mt-4"
          onClick={() => setAdjustOpen(true)}
          icon={<Plus className="size-4" />}
        >
          {t('inventory.adjustStock')}
        </Button>

        {/* Movement history — the ledger behind the stock number. */}
        <section className="mt-7">
          <SectionHeading title="Stock movements" />
          {data.events.length === 0 ? (
            <Card className="p-5 text-center text-sm text-[var(--color-muted)]">
              No movements recorded yet.
            </Card>
          ) : (
            <Card className="divide-y divide-[var(--color-line)]">
              {data.events.slice(0, 15).map((event) => (
                <div key={event.inventoryEventId} className="flex items-center gap-3 p-3.5">
                  <span
                    className={`flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] ${
                      event.quantityDelta > 0
                        ? 'bg-[var(--color-success-soft)] text-[var(--color-success)]'
                        : 'bg-[var(--color-sunken)] text-[var(--color-muted)]'
                    }`}
                  >
                    {event.quantityDelta > 0 ? (
                      <Plus className="size-4" aria-hidden="true" />
                    ) : (
                      <Minus className="size-4" aria-hidden="true" />
                    )}
                  </span>

                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-[var(--color-ink)]">
                      {event.type.replace('_', ' ')}
                    </p>
                    <p className="text-xs text-[var(--color-muted)]">
                      {formatTimelineDate(event.timestamp, locale)}
                      {event.note ? ` · ${event.note}` : ''}
                    </p>
                  </div>

                  <span className="shrink-0 text-right text-sm font-bold tabular">
                    <span
                      className={
                        event.quantityDelta > 0
                          ? 'text-[var(--color-success)]'
                          : 'text-[var(--color-ink)]'
                      }
                    >
                      {event.quantityDelta > 0 ? '+' : ''}
                      {event.quantityDelta}
                    </span>
                    <span className="block text-xs font-normal text-[var(--color-faint)]">
                      → {event.stockAfter}
                    </span>
                  </span>
                </div>
              ))}
            </Card>
          )}
        </section>
      </PageBody>

      <AdjustSheet
        open={adjustOpen}
        onClose={() => setAdjustOpen(false)}
        product={product}
        onAdjusted={() => void refetch()}
      />
    </PageTransition>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'success' }) {
  return (
    <Card className="p-3">
      <p className="text-[10px] font-semibold tracking-wide text-[var(--color-muted)] uppercase">
        {label}
      </p>
      <p
        className={`mt-1 text-base font-extrabold tabular ${
          tone === 'success' ? 'text-[var(--color-success)]' : 'text-[var(--color-ink)]'
        }`}
      >
        {value}
      </p>
    </Card>
  );
}

function AdjustSheet({
  open,
  onClose,
  product,
  onAdjusted,
}: {
  open: boolean;
  onClose: () => void;
  product: Product;
  onAdjusted: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [type, setType] = useState<InventoryEventType>('stock_in');
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const amount = Number(quantity) || 0;
  // stock_in and return add; everything else removes.
  const delta = type === 'stock_in' || type === 'return' ? amount : -amount;

  const submit = async () => {
    if (amount <= 0) return;
    setBusy(true);
    try {
      const result = await api.post<{ message: string }>('/inventory/adjust', {
        productId: product.productId,
        type,
        quantityDelta: delta,
        note,
      });
      toast.success(result.message);
      setQuantity('');
      setNote('');
      onClose();
      onAdjusted();
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
      title={t('inventory.adjustStock')}
      description={`${product.name} · ${product.stock} ${product.unit} now`}
      footer={
        <Button size="lg" block loading={busy} disabled={amount <= 0} onClick={() => void submit()}>
          {amount > 0
            ? `${product.stock} → ${product.stock + delta} ${product.unit}`
            : t('common.save')}
        </Button>
      }
    >
      <div className="space-y-4 pb-2">
        <Select
          label="What happened?"
          value={type}
          onChange={(event) => setType(event.target.value as InventoryEventType)}
        >
          {INVENTORY_EVENT_TYPES.map((entry) => (
            <option key={entry} value={entry}>
              {entry.replace('_', ' ')}
            </option>
          ))}
        </Select>

        <Input
          type="number"
          inputMode="decimal"
          label={t('sales.quantity')}
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          suffix={product.unit}
          autoFocus
        />

        <Input
          label={`${t('sales.note')} (${t('common.optional')})`}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Supplier delivery"
        />
      </div>
    </Sheet>
  );
}
