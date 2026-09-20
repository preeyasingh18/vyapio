import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Button.
 *
 * Sizes are set by touch target, not by text: `md` is 44px and `lg` is 52px,
 * which is what a shopkeeper's thumb needs on a phone held one-handed behind a
 * counter. `sm` exists for dense desktop toolbars only.
 */

const button = cva(
  [
    'inline-flex items-center justify-center gap-2 font-semibold whitespace-nowrap',
    'transition-[background-color,color,box-shadow,transform] duration-150',
    'active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]',
  ],
  {
    variants: {
      variant: {
        primary:
          'bg-[var(--color-primary)] text-[var(--color-primary-ink)] shadow-[var(--shadow-card)] hover:bg-[var(--color-primary-hover)]',
        accent:
          'bg-[var(--color-accent)] text-[var(--color-accent-ink)] shadow-[var(--shadow-card)] hover:brightness-105',
        secondary:
          'bg-[var(--color-sunken)] text-[var(--color-ink)] hover:bg-[var(--color-line)]',
        outline:
          'border border-[var(--color-line-strong)] bg-[var(--color-surface)] text-[var(--color-ink)] hover:bg-[var(--color-sunken)]',
        ghost: 'text-[var(--color-ink-soft)] hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink)]',
        danger:
          'bg-[var(--color-danger)] text-white shadow-[var(--shadow-card)] hover:brightness-110',
      },
      size: {
        sm: 'h-9 rounded-[var(--radius-control)] px-3 text-sm',
        md: 'h-11 rounded-[var(--radius-field)] px-4 text-sm',
        lg: 'h-13 rounded-[var(--radius-card)] px-6 text-base',
        icon: 'size-11 rounded-[var(--radius-field)]',
        'icon-sm': 'size-9 rounded-[var(--radius-control)]',
      },
      block: { true: 'w-full', false: '' },
    },
    defaultVariants: { variant: 'primary', size: 'md', block: false },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof button> & {
    loading?: boolean;
    /** Renders as a router link while keeping the button's appearance. */
    to?: string;
    icon?: ReactNode;
  };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, block, loading, disabled, children, to, icon, ...props },
  ref,
) {
  const classes = cn(button({ variant, size, block }), className);

  const content = (
    <>
      {loading ? (
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      ) : (
        icon
      )}
      {children}
    </>
  );

  if (to && !disabled && !loading) {
    return (
      <Link to={to} className={classes}>
        {content}
      </Link>
    );
  }

  return (
    <button
      ref={ref}
      className={classes}
      disabled={disabled || loading}
      // Tells assistive tech the control is working, not broken.
      aria-busy={loading || undefined}
      {...props}
    >
      {content}
    </button>
  );
});
