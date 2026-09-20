import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { cva, type VariantProps } from 'class-variance-authority';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { avatarHue, initials } from '@/lib/format';

export { Button, type ButtonProps } from './Button';
export {
  ActivityItem,
  AttentionRow,
  IconButton,
  Metric,
  MetricRow,
  Panel,
  QuickAction,
  Row,
  Rows,
  SearchBar,
  SectionHeader,
  SeeAll,
  StatusBadge,
  Table,
  type StatusTone,
} from './data';

/* ------------------------------------------------------------------- Card */

export function Card({
  className,
  interactive,
  ...props
}: HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return (
    <div
      className={cn(
        // `lit` adds the hairline top highlight that makes a surface read as
        // raised rather than as a bordered rectangle.
        'lit rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)]',
        interactive &&
          'cursor-pointer transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-[var(--shadow-lift)] active:translate-y-0',
        className,
      )}
      {...props}
    />
  );
}

/* ------------------------------------------------------------------ Badge */

const badge = cva(
  'inline-flex items-center gap-1 rounded-full font-semibold whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'bg-[var(--color-sunken)] text-[var(--color-ink-soft)]',
        primary: 'bg-[var(--color-primary-soft)] text-[var(--color-primary)]',
        accent: 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]',
        success: 'bg-[var(--color-success-soft)] text-[var(--color-success)]',
        warning: 'bg-[var(--color-warning-soft)] text-[var(--color-warning)]',
        danger: 'bg-[var(--color-danger-soft)] text-[var(--color-danger)]',
        gold: 'bg-[var(--color-gold-soft)] text-[var(--color-gold)]',
      },
      size: {
        sm: 'px-2 py-0.5 text-[11px]',
        md: 'px-2.5 py-1 text-xs',
      },
    },
    defaultVariants: { tone: 'neutral', size: 'md' },
  },
);

export function Badge({
  className,
  tone,
  size,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badge>) {
  return <span className={cn(badge({ tone, size }), className)} {...props} />;
}

/* ----------------------------------------------------------------- Avatar */

/**
 * Initials on a colour derived from the name, so the same customer is always
 * the same colour. Recognisable at a glance in a long list without needing a
 * photograph the shop will never have.
 */
export function Avatar({
  name,
  size = 'md',
  className,
}: {
  name: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}) {
  const hue = avatarHue(name);
  const sizes = {
    sm: 'size-8 text-[11px]',
    md: 'size-10 text-sm',
    lg: 'size-14 text-lg',
    xl: 'size-20 text-2xl',
  } as const;

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-bold select-none',
        sizes[size],
        className,
      )}
      style={{
        backgroundColor: `oklch(0.92 0.045 ${hue})`,
        color: `oklch(0.42 0.13 ${hue})`,
      }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

/* ------------------------------------------------------------------ Input */

type FieldProps = {
  label?: string;
  hint?: string;
  error?: string;
  /**
   * Rendered inside the field, e.g. a ₹ sign or +91.
   *
   * Note the `Omit<..., 'prefix'>` on Input below: HTML already defines a
   * `prefix` attribute as a plain string (it is an RDFa hold-over), so without
   * omitting it TypeScript resolves this to `string & ReactNode`.
   */
  prefix?: ReactNode;
  suffix?: ReactNode;
};

const fieldBase =
  'w-full rounded-[var(--radius-field)] border bg-[var(--color-surface)] text-[var(--color-ink)] placeholder:text-[var(--color-faint)] transition-colors focus:outline-none disabled:opacity-60';

export const Input = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix'> & FieldProps
>(
  function Input({ label, hint, error, prefix, suffix, className, id, ...props }, ref) {
    const generatedId = useId();
    const inputId = id ?? generatedId;
    const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;

    return (
      <div className="w-full">
        {label ? (
          <label htmlFor={inputId} className="mb-1.5 block text-sm font-medium text-[var(--color-ink-soft)]">
            {label}
          </label>
        ) : null}

        {/*
          With an adornment the box becomes a flex row and the input sits
          *beside* the affix rather than under it.
          
          The affixes used to be positioned absolutely over a field with a
          fixed pl-9 / pr-12, which only ever fitted a one-character "₹".
          "+91" is wider than that reserve, so a typed number ran straight into
          the prefix and read as one long string — and a unit like "packet"
          did the same on the right. Laying them out means the box fits
          whatever it is given, with no width to keep in step by hand.

          A field with no affix keeps the plain single-element markup, so the
          `className` callers pass still lands where they expect it to.
        */}
        {prefix || suffix ? (
          <div
            className={cn(
              fieldBase,
              'flex h-12 items-center gap-1.5 px-3.5 text-base sm:text-sm',
              error
                ? 'border-[var(--color-danger)] focus-within:border-[var(--color-danger)]'
                : 'border-[var(--color-line-strong)] focus-within:border-[var(--color-primary)]',
              className,
            )}
          >
            {prefix ? (
              <span className="shrink-0 text-[var(--color-muted)] select-none">{prefix}</span>
            ) : null}

            <input
              ref={ref}
              id={inputId}
              className="w-full min-w-0 flex-1 bg-transparent text-inherit placeholder:text-[var(--color-faint)] focus:outline-none disabled:opacity-60"
              aria-invalid={error ? true : undefined}
              aria-describedby={describedBy}
              {...props}
            />

            {suffix ? (
              <span className="shrink-0 text-sm text-[var(--color-muted)] select-none">
                {suffix}
              </span>
            ) : null}
          </div>
        ) : (
          <input
            ref={ref}
            id={inputId}
            className={cn(
              fieldBase,
              // 16px on mobile prevents iOS from zooming the viewport on focus.
              'h-12 px-3.5 text-base sm:text-sm',
              error
                ? 'border-[var(--color-danger)] focus:border-[var(--color-danger)]'
                : 'border-[var(--color-line-strong)] focus:border-[var(--color-primary)]',
              className,
            )}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            {...props}
          />
        )}

        {error ? (
          <p id={`${inputId}-error`} className="mt-1.5 text-sm text-[var(--color-danger)]" role="alert">
            {error}
          </p>
        ) : hint ? (
          <p id={`${inputId}-hint`} className="mt-1.5 text-sm text-[var(--color-muted)]">
            {hint}
          </p>
        ) : null}
      </div>
    );
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & FieldProps
>(function Textarea({ label, hint, error, className, id, ...props }, ref) {
  const generatedId = useId();
  const textareaId = id ?? generatedId;

  return (
    <div className="w-full">
      {label ? (
        <label htmlFor={textareaId} className="mb-1.5 block text-sm font-medium text-[var(--color-ink-soft)]">
          {label}
        </label>
      ) : null}
      <textarea
        ref={ref}
        id={textareaId}
        className={cn(
          fieldBase,
          'min-h-24 resize-y p-3.5 text-base sm:text-sm',
          error ? 'border-[var(--color-danger)]' : 'border-[var(--color-line-strong)] focus:border-[var(--color-primary)]',
          className,
        )}
        aria-invalid={error ? true : undefined}
        {...props}
      />
      {error ? (
        <p className="mt-1.5 text-sm text-[var(--color-danger)]" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1.5 text-sm text-[var(--color-muted)]">{hint}</p>
      ) : null}
    </div>
  );
});

export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement> & FieldProps
>(function Select({ label, hint, error, className, id, children, ...props }, ref) {
  const generatedId = useId();
  const selectId = id ?? generatedId;

  return (
    <div className="w-full">
      {label ? (
        <label htmlFor={selectId} className="mb-1.5 block text-sm font-medium text-[var(--color-ink-soft)]">
          {label}
        </label>
      ) : null}
      <select
        ref={ref}
        id={selectId}
        className={cn(
          fieldBase,
          'h-12 appearance-none px-3.5 pr-10 text-base sm:text-sm',
          // Chevron drawn inline so the control needs no extra markup.
          "bg-[length:1.25rem] bg-[right_0.75rem_center] bg-no-repeat",
          error ? 'border-[var(--color-danger)]' : 'border-[var(--color-line-strong)] focus:border-[var(--color-primary)]',
          className,
        )}
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%2371717a' stroke-width='2'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")",
        }}
        aria-invalid={error ? true : undefined}
        {...props}
      >
        {children}
      </select>
      {error ? (
        <p className="mt-1.5 text-sm text-[var(--color-danger)]" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1.5 text-sm text-[var(--color-muted)]">{hint}</p>
      ) : null}
    </div>
  );
});

/* ------------------------------------------------------------------ Sheet */

/**
 * Bottom sheet on mobile, centred dialog on desktop.
 *
 * Handles the things a modal has to get right: focus moves in on open and
 * returns on close, Escape dismisses, and the page behind does not scroll.
 */
export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();

  /**
   * Held in a ref so the effect below does not depend on its identity.
   *
   * Every caller passes an inline arrow — `onClose={() => setOpen(false)}` —
   * which is a new function on every render. With it in the dependency array
   * the whole open/close effect tore down and re-ran on each keystroke, and its
   * cleanup pulls focus back out of the sheet. The result was a form you had to
   * click before every single character.
   */
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    restoreFocus.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    /**
     * Focus the panel, unless something inside it has already claimed focus.
     *
     * Fields that open ready to type say so with `autoFocus`, and moving focus
     * to the panel a moment later would quietly undo that — the caret would
     * appear, then vanish before the first keypress.
     */
    const timer = window.setTimeout(() => {
      const panel = panelRef.current;
      if (panel && !panel.contains(document.activeElement)) panel.focus();
    }, 50);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreFocus.current?.focus();
    };
  }, [open]);

  const widths = { sm: 'sm:max-w-md', md: 'sm:max-w-lg', lg: 'sm:max-w-2xl' } as const;

  return createPortal(
    <AnimatePresence>
      {open ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="absolute inset-0 bg-black/45 backdrop-blur-[2px]"
            onClick={onClose}
            aria-hidden="true"
          />

          <motion.div
            ref={panelRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? titleId : undefined}
            initial={{ y: '100%', opacity: 0.6 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: '100%', opacity: 0.6 }}
            transition={{ type: 'spring', stiffness: 380, damping: 36 }}
            className={cn(
              'relative flex max-h-[92dvh] w-full flex-col rounded-t-[var(--radius-sheet)] bg-[var(--color-elevated)] shadow-[var(--shadow-sheet)] outline-none',
              'sm:rounded-[var(--radius-sheet)]',
              widths[size],
            )}
          >
            {/* Drag affordance — visual only; Escape and the close button do the work. */}
            <div className="flex justify-center pt-3 sm:hidden">
              <span className="h-1 w-10 rounded-full bg-[var(--color-line-strong)]" />
            </div>

            {title ? (
              <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-2 sm:pt-6">
                <div className="min-w-0">
                  <h2 id={titleId} className="text-lg font-bold text-[var(--color-ink)]">
                    {title}
                  </h2>
                  {description ? (
                    <p className="mt-1 text-sm text-[var(--color-muted)]">{description}</p>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  className="-m-1.5 rounded-[var(--radius-field)] p-1.5 text-[var(--color-muted)] transition-colors hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink)]"
                  aria-label="Close"
                >
                  <X className="size-5" aria-hidden="true" />
                </button>
              </div>
            ) : null}

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">{children}</div>

            {footer ? (
              <div className="border-t border-[var(--color-line)] px-5 py-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] sm:pb-4">
                {footer}
              </div>
            ) : (
              <div className="pb-[env(safe-area-inset-bottom)]" />
            )}
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

/* -------------------------------------------------------------- Skeleton */

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn('shimmer rounded-[var(--radius-field)] bg-[var(--color-sunken)]', className)}
      aria-hidden="true"
    />
  );
}

/* ------------------------------------------------------------ EmptyState */

export function EmptyState({
  icon,
  title,
  body,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center px-6 py-14 text-center', className)}>
      {icon ? (
        <div className="mb-4 flex size-14 items-center justify-center rounded-[var(--radius-card)] bg-[var(--color-sunken)] text-[var(--color-muted)]">
          {icon}
        </div>
      ) : null}
      <h3 className="text-base font-semibold text-[var(--color-ink)]">{title}</h3>
      {body ? (
        <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-[var(--color-muted)]">{body}</p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ Tabs */

export function Tabs<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string; count?: number }>;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cn(
        'inline-flex gap-1 rounded-[var(--radius-field)] bg-[var(--color-sunken)] p-1',
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'relative rounded-[var(--radius-control)] px-3.5 py-2 text-sm font-semibold transition-colors',
              active ? 'text-[var(--color-ink)]' : 'text-[var(--color-muted)] hover:text-[var(--color-ink-soft)]',
            )}
          >
            {active ? (
              <motion.span
                layoutId="tab-indicator"
                className="absolute inset-0 rounded-[var(--radius-control)] bg-[var(--color-surface)] shadow-[var(--shadow-card)]"
                transition={{ type: 'spring', stiffness: 400, damping: 32 }}
              />
            ) : null}
            <span className="relative flex items-center gap-1.5">
              {option.label}
              {option.count !== undefined ? (
                <span className="text-xs text-[var(--color-faint)] tabular">{option.count}</span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ----------------------------------------------------------------- Switch */

export function Switch({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors',
          checked ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-line-strong)]',
        )}
      >
        <motion.span
          layout
          transition={{ type: 'spring', stiffness: 500, damping: 34 }}
          className={cn(
            'absolute top-0.5 size-5 rounded-full bg-white shadow-sm',
            checked ? 'left-[1.375rem]' : 'left-0.5',
          )}
        />
      </button>
      <label htmlFor={id} className="cursor-pointer select-none">
        <span className="block text-sm font-medium text-[var(--color-ink)]">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-sm text-[var(--color-muted)]">{description}</span>
        ) : null}
      </label>
    </div>
  );
}
