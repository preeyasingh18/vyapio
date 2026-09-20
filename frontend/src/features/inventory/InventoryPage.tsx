import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Boxes, PackagePlus, Pencil, Plus, Trash2 } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { PageBody, PageHeader } from '@/components/layout/PageHeader';
import {
  Button,
  EmptyState,
  IconButton,
  Input,
  Panel,
  SearchBar,
  Select,
  Sheet,
  Skeleton,
  StatusBadge,
  Table,
  Tabs,
  type StatusTone,
} from '@/components/ui';
import { PageTransition } from '@/components/motion';
import { useT } from '@/app/providers/I18nProvider';
import { useToast } from '@/app/providers/ToastProvider';
import { useQuery } from '@/hooks/useApi';
import { api, ApiError } from '@/lib/api';
import { formatMoney, formatMoneyCompact } from '@/lib/format';
import type { Product } from '@shared/entities';

/**
 * Stock.
 *
 * A purchase-and-stock screen: what is on the shelf, what it is worth, who it
 * came from, and what needs buying. Every figure is computed on the server in
 * plain arithmetic — including the status badge, which is derived from quantity
 * and reorder level rather than stored, so it can never disagree with the
 * number sitting next to it.
 *
 * The table is the primary object. Filters narrow it, sorting reorders it, and
 * neither hides a row's status from the shopkeeper scanning down the column.
 */

type StockStatus = 'in_stock' | 'low_stock' | 'out_of_stock';

type ProductRow = Product & {
  /** Quantity x cost price, in paise. From the server. */
  stockValue: number;
  /** Derived server-side. See backend/src/services/inventory.ts. */
  stockStatus: StockStatus;
  insight: {
    soldThisWeek: number;
    salesVelocity: number;
    daysRemaining: number | null;
    lowStock: boolean;
    outOfStock: boolean;
    belowReorderLevel: boolean;
    marginPercent: number;
    suggestedRestockQuantity: number;
  };
};

type InventoryResponse = {
  products: ProductRow[];
  totals: {
    count: number;
    inStockCount: number;
    lowStockCount: number;
    outOfStockCount: number;
    runningOutCount: number;
    stockValue: number;
  };
  thresholds: { lowStockDays: number };
};

type Filter = 'all' | 'in_stock' | 'low_stock' | 'out_of_stock';
type SortKey = 'name' | 'price' | 'quantity' | 'value' | 'purchaseDate';

const STATUS_TONE: Record<StockStatus, StatusTone> = {
  in_stock: 'success',
  low_stock: 'warning',
  out_of_stock: 'danger',
};

const STATUS_KEY: Record<StockStatus, string> = {
  in_stock: 'inventory.statusInStock',
  low_stock: 'inventory.statusLowStock',
  out_of_stock: 'inventory.statusOutOfStock',
};

/**
 * Same rule as the server, for rows that arrive without a status — an older
 * cached response, or an optimistic row. The server remains the source of
 * truth; this only keeps the screen from rendering a blank badge.
 */
function statusOf(product: ProductRow): StockStatus {
  if (product.stockStatus) return product.stockStatus;
  if (product.stock <= 0) return 'out_of_stock';
  // Mirrors the server. See LOW_STOCK_THRESHOLD in services/inventory.ts.
  if (product.stock <= 5) return 'low_stock';
  return 'in_stock';
}

function valueOf(product: ProductRow): number {
  return product.stockValue ?? Math.max(0, product.stock) * product.costPrice;
}

/** `2026-09-10` → `10 Sep 2026`. Empty stays empty; the cell shows a dash. */
function formatDay(value: string, locale: string): string {
  if (!value) return '';
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export default function InventoryPage() {
  const t = useT();
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('name');
  const [descending, setDescending] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<ProductRow | null>(null);
  const [restocking, setRestocking] = useState<ProductRow | null>(null);

  const { data, loading, error, refetch } = useQuery<InventoryResponse>('/inventory');

  /**
   * Opens straight onto one product's restock sheet when arrived at from the
   * low-stock reminder, which names the item — so the shopkeeper should not
   * then have to find it again in the list.
   *
   * Derived from the URL rather than copied into state by an effect: the
   * address bar already holds this, and a second copy only creates the question
   * of which one is right after a refresh or a back-navigation.
   */
  const [params, setParams] = useSearchParams();
  const requestedRestock = params.get('restock');
  const restockTarget =
    restocking ??
    (requestedRestock
      ? (data?.products.find((entry) => entry.productId === requestedRestock) ?? null)
      : null);

  const closeRestock = () => {
    setRestocking(null);
    if (requestedRestock) setParams({}, { replace: true });
  };

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    let list = data?.products ?? [];

    if (needle) {
      list = list.filter(
        (product) =>
          product.name.toLowerCase().includes(needle) ||
          (product.supplier ?? '').toLowerCase().includes(needle),
      );
    }

    if (filter !== 'all') list = list.filter((product) => statusOf(product) === filter);

    const direction = descending ? -1 : 1;
    return [...list].sort((a, b) => {
      switch (sort) {
        case 'price':
          return (a.costPrice - b.costPrice) * direction;
        case 'quantity':
          return (a.stock - b.stock) * direction;
        case 'value':
          return (valueOf(a) - valueOf(b)) * direction;
        case 'purchaseDate':
          // Blank dates sort last in either direction: "not recorded" is not a
          // point in time, so pretending it is the oldest would be a lie.
          if (!a.purchaseDate && !b.purchaseDate) return 0;
          if (!a.purchaseDate) return 1;
          if (!b.purchaseDate) return -1;
          return a.purchaseDate.localeCompare(b.purchaseDate) * direction;
        default:
          return a.name.localeCompare(b.name) * direction;
      }
    });
  }, [data, search, filter, sort, descending]);

  const totals = data?.totals;
  const filtered = search.trim().length > 0 || filter !== 'all';

  return (
    <PageTransition>
      <PageHeader
        title={t('inventory.title')}
        actions={
          <Button size="sm" onClick={() => setAddOpen(true)} icon={<Plus className="size-4" />}>
            <span className="hidden sm:inline">{t('inventory.add')}</span>
          </Button>
        }
      />

      <PageBody>
        {/* ── Summary ─────────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <SummaryCard
            tint="lavender"
            label={t('inventory.totalItems')}
            value={totals ? String(totals.count) : '—'}
            loading={loading && !data}
          />
          <SummaryCard
            tint="mint"
            label={t('inventory.totalStockValue')}
            value={totals ? formatMoneyCompact(totals.stockValue) : '—'}
            loading={loading && !data}
          />
          <SummaryCard
            tint="peach"
            label={t('inventory.lowStockItems')}
            value={totals ? String(totals.lowStockCount) : '—'}
            loading={loading && !data}
          />
          <SummaryCard
            tint="butter"
            label={t('inventory.outOfStockItems')}
            value={totals ? String(totals.outOfStockCount) : '—'}
            loading={loading && !data}
          />
        </div>

        {/* ── Controls ────────────────────────────────────────────────────── */}
        <div className="mt-5 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <SearchBar
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onClear={() => setSearch('')}
            placeholder={t('inventory.searchWide')}
            aria-label={t('inventory.searchWide')}
            className="xl:max-w-xs"
          />

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <Tabs
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: t('inventory.filterAll'), count: totals?.count },
                {
                  value: 'in_stock',
                  label: t('inventory.filterInStock'),
                  count: totals?.inStockCount,
                },
                {
                  value: 'low_stock',
                  label: t('inventory.filterLowStock'),
                  count: totals?.lowStockCount,
                },
                {
                  value: 'out_of_stock',
                  label: t('inventory.filterOutOfStock'),
                  count: totals?.outOfStockCount,
                },
              ]}
            />

            <div className="flex items-center gap-2">
              <Select
                aria-label={t('inventory.sortBy')}
                value={sort}
                onChange={(event) => setSort(event.target.value as SortKey)}
                className="sm:w-44"
              >
                <option value="name">{t('inventory.sortName')}</option>
                <option value="price">{t('inventory.sortPrice')}</option>
                <option value="quantity">{t('inventory.sortQuantity')}</option>
                <option value="value">{t('inventory.sortValue')}</option>
                <option value="purchaseDate">{t('inventory.sortPurchaseDate')}</option>
              </Select>
              <IconButton
                label={descending ? t('common.sortDescending') : t('common.sortAscending')}
                onClick={() => setDescending((current) => !current)}
                icon={
                  descending ? <ArrowDown className="size-4" /> : <ArrowUp className="size-4" />
                }
              />
            </div>
          </div>
        </div>

        {/* ── Table ───────────────────────────────────────────────────────── */}
        {loading && !data ? (
          <Panel inset className="mt-4 space-y-3">
            {Array.from({ length: 8 }).map((_, index) => (
              <Skeleton key={index} className="h-10" />
            ))}
          </Panel>
        ) : error ? (
          <Panel inset className="mt-4 text-center">
            <p className="text-sm text-[var(--color-muted)]">{error.message}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => void refetch()}>
              {t('common.retry')}
            </Button>
          </Panel>
        ) : (
          <Panel className="mt-4 px-4 sm:px-5">
            <StockTable
              rows={rows}
              t={t}
              onEdit={setEditing}
              onRestock={setRestocking}
              onChanged={() => void refetch()}
              empty={
                <EmptyState
                  icon={<Boxes className="size-6" />}
                  title={
                    search
                      ? t('inventory.noMatches')
                      : filtered
                        ? t('inventory.noneMatchFilter')
                        : t('inventory.empty')
                  }
                  body={filtered ? undefined : t('inventory.emptyBody')}
                  action={
                    filtered ? null : (
                      <Button onClick={() => setAddOpen(true)} icon={<Plus className="size-4" />}>
                        {t('inventory.add')}
                      </Button>
                    )
                  }
                />
              }
            />
          </Panel>
        )}
      </PageBody>

      <ProductSheet
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSaved={() => void refetch()}
      />
      {/*
        Keyed by item so the form state is rebuilt for each one. Without it the
        sheet stays mounted between opens and the second item edited would be
        shown the first one's values.
      */}
      <ProductSheet
        key={editing?.productId ?? 'edit'}
        open={editing !== null}
        product={editing}
        onClose={() => setEditing(null)}
        onSaved={() => void refetch()}
      />
      <RestockSheet
        key={restockTarget?.productId ?? 'restock'}
        product={restockTarget}
        onClose={closeRestock}
        onSaved={() => void refetch()}
      />
    </PageTransition>
  );
}

/* ---------------------------------------------------------------- Summary */

/**
 * One figure on a tinted ground, matching the home screen's cards.
 *
 * The tint groups: lavender for a count, mint for money, peach for what is
 * running low, butter for what has run out. Ink stays common across all four
 * so the row reads as one object rather than four competing signals.
 */
function SummaryCard({
  label,
  value,
  tint,
  loading,
}: {
  label: string;
  value: string;
  tint: 'lavender' | 'peach' | 'mint' | 'butter';
  loading?: boolean;
}) {
  return (
    <div
      className="rounded-[var(--radius-card)] px-4 py-3.5"
      style={{ backgroundColor: `var(--color-${tint})` }}
    >
      <p className="truncate text-[length:var(--text-eyebrow)] font-semibold tracking-[0.08em] text-[var(--color-ink-soft)] uppercase">
        {label}
      </p>
      {loading ? (
        <Skeleton className="mt-2 h-7 w-20" />
      ) : (
        <p className="mt-1 text-2xl font-bold text-[var(--color-ink)] tabular">{value}</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ Table */

function StockTable({
  rows,
  t,
  onEdit,
  onRestock,
  onChanged,
  empty,
}: {
  rows: ProductRow[];
  t: (key: string, values?: Record<string, string | number>) => string;
  onEdit: (product: ProductRow) => void;
  onRestock: (product: ProductRow) => void;
  onChanged: () => void;
  empty?: React.ReactNode;
}) {
  const toast = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);

  const remove = async (product: ProductRow) => {
    if (!window.confirm(t('inventory.deleteConfirm', { name: product.name }))) return;
    setBusyId(product.productId);
    try {
      await api.delete(`/inventory/${product.productId}`);
      toast.success(t('inventory.deleted'), product.name);
      onChanged();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : t('common.somethingWentWrong'));
    } finally {
      setBusyId(null);
    }
  };

  const badge = (product: ProductRow) => {
    const status = statusOf(product);
    return <StatusBadge tone={STATUS_TONE[status]}>{t(STATUS_KEY[status])}</StatusBadge>;
  };

  const actions = (product: ProductRow) => (
    // `relative z-10` so these stay clickable if the row ever gains a link.
    <div className="relative z-10 flex items-center justify-end gap-0.5">
      <IconButton
        size="sm"
        label={t('inventory.restock')}
        icon={<PackagePlus className="size-4" />}
        onClick={() => onRestock(product)}
      />
      <IconButton
        size="sm"
        label={t('inventory.edit')}
        icon={<Pencil className="size-4" />}
        onClick={() => onEdit(product)}
      />
      <IconButton
        size="sm"
        tone="danger"
        label={t('inventory.delete')}
        icon={<Trash2 className="size-4" />}
        disabled={busyId === product.productId}
        onClick={() => void remove(product)}
      />
    </div>
  );

  return (
    <Table
      rows={rows}
      getKey={(product) => product.productId}
      empty={empty}
      columns={[
        {
          key: 'name',
          header: t('inventory.columnProduct'),
          cell: (product) => (
            <div className="min-w-0">
              <p className="truncate font-semibold text-[var(--color-ink)]">{product.name}</p>
              <p className="text-xs text-[var(--color-muted)] lg:hidden">
                {product.supplier || t('inventory.notRecorded')}
              </p>
            </div>
          ),
        },
        {
          key: 'supplier',
          header: t('inventory.supplier'),
          hideBelow: 'lg',
          width: '16%',
          cell: (product) => (
            <span className="text-[var(--color-ink-soft)]">
              {product.supplier || <span className="text-[var(--color-faint)]">—</span>}
            </span>
          ),
        },
        {
          key: 'price',
          header: t('inventory.unitPrice'),
          align: 'right',
          width: '11%',
          cell: (product) => (
            <span className="text-[var(--color-ink-soft)] tabular">
              {formatMoney(product.costPrice)}
              <span className="text-[var(--color-faint)]">/{product.unit}</span>
            </span>
          ),
        },
        {
          key: 'quantity',
          header: t('inventory.quantity'),
          align: 'right',
          width: '10%',
          cell: (product) => (
            <span className="text-[var(--color-ink)] tabular">
              {product.stock} {product.unit}
            </span>
          ),
        },
        {
          key: 'reorder',
          header: t('inventory.reorderLevel'),
          align: 'right',
          hideBelow: 'xl',
          width: '9%',
          cell: (product) => (
            <span className="text-[var(--color-muted)] tabular">{product.reorderLevel}</span>
          ),
        },
        {
          key: 'value',
          header: t('inventory.totalValue'),
          align: 'right',
          width: '11%',
          cell: (product) => (
            <span className="font-semibold text-[var(--color-ink)] tabular">
              {formatMoney(valueOf(product))}
            </span>
          ),
        },
        {
          key: 'purchased',
          header: t('inventory.purchaseDate'),
          align: 'right',
          hideBelow: 'xl',
          width: '12%',
          cell: (product) => (
            <span className="text-[var(--color-muted)] tabular">
              {formatDay(product.purchaseDate, 'en-IN') || (
                <span className="text-[var(--color-faint)]">—</span>
              )}
            </span>
          ),
        },
        {
          key: 'status',
          header: t('inventory.columnStatus'),
          align: 'right',
          width: '13%',
          cell: (product) => badge(product),
        },
        {
          key: 'actions',
          header: t('inventory.columnActions'),
          align: 'right',
          width: '11%',
          cell: (product) => actions(product),
        },
      ]}
      renderCard={(product) => (
        <div className="py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-[var(--color-ink)]">
                {product.name}
              </p>
              <p className="mt-0.5 truncate text-xs text-[var(--color-muted)]">
                {product.supplier || t('inventory.notRecorded')}
              </p>
            </div>
            {badge(product)}
          </div>

          <div className="mt-2 flex items-center justify-between gap-3">
            <p className="text-xs text-[var(--color-ink-soft)] tabular">
              {product.stock} {product.unit} · {formatMoney(product.costPrice)}/{product.unit} ·{' '}
              <span className="font-semibold text-[var(--color-ink)]">
                {formatMoney(valueOf(product))}
              </span>
            </p>
            {actions(product)}
          </div>
        </div>
      )}
    />
  );
}

/* ------------------------------------------------------- Add / edit sheet */

type FormState = {
  name: string;
  supplier: string;
  unit: string;
  cost: string;
  price: string;
  stock: string;
  reorderLevel: string;
  purchaseDate: string;
};

const EMPTY_FORM: FormState = {
  name: '',
  supplier: '',
  unit: 'kg',
  cost: '',
  price: '',
  stock: '',
  reorderLevel: '',
  purchaseDate: '',
};

function formFor(product: ProductRow | null | undefined): FormState {
  if (!product) return { ...EMPTY_FORM, purchaseDate: new Date().toISOString().slice(0, 10) };
  return {
    name: product.name,
    supplier: product.supplier ?? '',
    unit: product.unit,
    cost: String(product.costPrice / 100),
    price: String(product.sellingPrice / 100),
    stock: String(product.stock),
    reorderLevel: String(product.reorderLevel),
    purchaseDate: product.purchaseDate ?? '',
  };
}

/**
 * Client-side validation, mirroring the request schema.
 *
 * The server validates the same rules and is what actually protects the data;
 * this exists so the shopkeeper is told at the field rather than after a round
 * trip. Where the two could drift, the server wins — its errors are rendered
 * underneath by `error.issueFor`.
 */
function validate(form: FormState, t: (key: string) => string): Partial<Record<keyof FormState, string>> {
  const problems: Partial<Record<keyof FormState, string>> = {};
  const number = (value: string) => (value.trim() === '' ? 0 : Number(value));

  if (!form.name.trim()) problems.name = t('inventory.nameRequired');
  if (!form.supplier.trim()) problems.supplier = t('inventory.supplierRequired');

  const cost = number(form.cost);
  const price = number(form.price);
  if (!Number.isFinite(cost) || cost < 0) problems.cost = t('inventory.priceInvalid');
  if (!Number.isFinite(price) || price < 0) problems.price = t('inventory.priceInvalid');

  const stock = number(form.stock);
  if (!Number.isFinite(stock) || stock < 0) problems.stock = t('inventory.quantityInvalid');

  const reorder = number(form.reorderLevel);
  if (!Number.isFinite(reorder) || reorder < 0) problems.reorderLevel = t('inventory.reorderInvalid');

  if (form.purchaseDate) {
    const parsed = new Date(`${form.purchaseDate}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) problems.purchaseDate = t('inventory.dateInvalid');
  }

  return problems;
}

function ProductSheet({
  open,
  product,
  onClose,
  onSaved,
}: {
  open: boolean;
  product?: ProductRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const editing = Boolean(product);

  // Keyed remount below means this initialises once per opened item.
  const [form, setForm] = useState<FormState>(() => formFor(product));
  const [problems, setProblems] = useState<Partial<Record<keyof FormState, string>>>({});
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof FormState>(key: K, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
    setProblems((current) => ({ ...current, [key]: undefined }));
  };

  const submit = async () => {
    const found = validate(form, t);
    setProblems(found);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    setError(null);
    try {
      // Rupees in the form, paise on the wire — money is integer paise
      // everywhere behind this boundary.
      const body = {
        name: form.name.trim(),
        supplier: form.supplier.trim(),
        unit: form.unit.trim() || 'unit',
        costPrice: Math.round((Number(form.cost) || 0) * 100),
        sellingPrice: Math.round((Number(form.price) || 0) * 100),
        stock: Number(form.stock) || 0,
        reorderLevel: Number(form.reorderLevel) || 0,
        purchaseDate: form.purchaseDate,
      };

      if (product) {
        await api.patch(`/inventory/${product.productId}`, body);
        toast.success(t('inventory.updated'), body.name);
      } else {
        await api.post('/inventory', body);
        toast.success(t('inventory.added'), body.name);
      }
      onClose();
      onSaved();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : null);
    } finally {
      setBusy(false);
    }
  };

  const issue = (field: keyof FormState, apiField = field as string) =>
    problems[field] ?? error?.issueFor(apiField) ?? undefined;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={editing ? t('inventory.editProduct') : t('inventory.add')}
      footer={
        <Button size="lg" block loading={busy} onClick={() => void submit()}>
          {t('common.save')}
        </Button>
      }
    >
      <div className="space-y-4 pb-2">
        <Input
          label={t('sales.itemName')}
          value={form.name}
          onChange={(event) => set('name', event.target.value)}
          placeholder="Rice"
          autoFocus={!editing}
          {...(issue('name') ? { error: issue('name') } : {})}
        />

        <Input
          label={t('inventory.supplier')}
          value={form.supplier}
          onChange={(event) => set('supplier', event.target.value)}
          placeholder={t('inventory.supplierPlaceholder')}
          {...(issue('supplier') ? { error: issue('supplier') } : {})}
        />

        <div className="grid grid-cols-2 gap-3">
          <Input
            type="number"
            inputMode="decimal"
            min="0"
            label={t('inventory.costPrice')}
            value={form.cost}
            onChange={(event) => set('cost', event.target.value)}
            prefix="₹"
            {...(issue('cost', 'costPrice') ? { error: issue('cost', 'costPrice') } : {})}
          />
          <Input
            type="number"
            inputMode="decimal"
            min="0"
            label={t('inventory.sellingPrice')}
            value={form.price}
            onChange={(event) => set('price', event.target.value)}
            prefix="₹"
            {...(issue('price', 'sellingPrice') ? { error: issue('price', 'sellingPrice') } : {})}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Input
            type="number"
            inputMode="decimal"
            min="0"
            label={editing ? t('inventory.quantity') : t('inventory.openingStock')}
            value={form.stock}
            onChange={(event) => set('stock', event.target.value)}
            {...(issue('stock') ? { error: issue('stock') } : {})}
          />
          <Input
            label={t('inventory.unitLabel')}
            value={form.unit}
            onChange={(event) => set('unit', event.target.value)}
            placeholder="kg"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Input
            type="number"
            inputMode="decimal"
            min="0"
            label={t('inventory.reorderLevel')}
            value={form.reorderLevel}
            onChange={(event) => set('reorderLevel', event.target.value)}
            {...(issue('reorderLevel') ? { error: issue('reorderLevel') } : {})}
          />
          <Input
            type="date"
            label={t('inventory.purchaseDate')}
            value={form.purchaseDate}
            onChange={(event) => set('purchaseDate', event.target.value)}
            {...(issue('purchaseDate') ? { error: issue('purchaseDate') } : {})}
          />
        </div>

        {error && error.issues.length === 0 ? (
          <p
            className="rounded-[var(--radius-field)] bg-[var(--color-danger-soft)] px-3.5 py-3 text-sm text-[var(--color-danger)]"
            role="alert"
          >
            {error.message}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}

/* ----------------------------------------------------------- Restock sheet */

function RestockSheet({
  product,
  onClose,
  onSaved,
}: {
  product: ProductRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const added = Number(quantity) || 0;
  const valid = added > 0;
  const newQuantity = (product?.stock ?? 0) + added;

  const submit = async () => {
    if (!product || !valid) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/inventory/adjust', {
        productId: product.productId,
        type: 'stock_in',
        quantityDelta: added,
        ...(price.trim() ? { unitPrice: Math.round(Number(price) * 100) } : {}),
        purchaseDate: date,
        note: `Restocked from ${product.supplier || 'supplier'}`,
      });
      toast.success(t('inventory.restocked'), `${product.name} · ${newQuantity} ${product.unit}`);
      setQuantity('');
      setPrice('');
      onClose();
      onSaved();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={product !== null}
      onClose={onClose}
      title={product ? t('inventory.restockTitle', { name: product.name }) : t('inventory.restock')}
      footer={
        <Button size="lg" block loading={busy} disabled={!valid} onClick={() => void submit()}>
          {t('inventory.restock')}
        </Button>
      }
    >
      {product ? (
        <div className="space-y-4 pb-2">
          {/* What is there now, so the new figure below is read in context. */}
          <div className="flex items-center justify-between rounded-[var(--radius-field)] bg-[var(--color-sunken)] px-3.5 py-3">
            <span className="text-sm text-[var(--color-muted)]">
              {t('inventory.currentQuantity')}
            </span>
            <span className="text-sm font-semibold text-[var(--color-ink)] tabular">
              {product.stock} {product.unit}
            </span>
          </div>

          <Input
            type="number"
            inputMode="decimal"
            min="0"
            label={t('inventory.addQuantity')}
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            autoFocus
            suffix={product.unit}
            {...(error?.issueFor('quantityDelta')
              ? { error: error.issueFor('quantityDelta') }
              : {})}
          />

          <Input
            type="number"
            inputMode="decimal"
            min="0"
            label={t('inventory.purchasePrice')}
            hint={t('inventory.purchasePriceHint')}
            value={price}
            onChange={(event) => setPrice(event.target.value)}
            prefix="₹"
            placeholder={String(product.costPrice / 100)}
            {...(error?.issueFor('unitPrice') ? { error: error.issueFor('unitPrice') } : {})}
          />

          <Input
            type="date"
            label={t('inventory.purchaseDate')}
            value={date}
            onChange={(event) => setDate(event.target.value)}
            {...(error?.issueFor('purchaseDate') ? { error: error.issueFor('purchaseDate') } : {})}
          />

          {valid ? (
            <div className="flex items-center justify-between rounded-[var(--radius-field)] border border-[var(--color-line)] px-3.5 py-3">
              <span className="text-sm text-[var(--color-muted)]">
                {t('inventory.newQuantity')}
              </span>
              <span className="text-sm font-semibold text-[var(--color-ink)] tabular">
                {newQuantity} {product.unit}
              </span>
            </div>
          ) : null}

          {error && error.issues.length === 0 ? (
            <p
              className="rounded-[var(--radius-field)] bg-[var(--color-danger-soft)] px-3.5 py-3 text-sm text-[var(--color-danger)]"
              role="alert"
            >
              {error.message}
            </p>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
}
