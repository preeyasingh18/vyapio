import {
  ArrowRight,
  Boxes,
  Brain,
  Receipt,
  Sparkles,
  Users,
  Wallet,
} from 'lucide-react';
import { FadeIn } from '@/components/motion';
import { cn } from '@/lib/cn';

/**
 * The chain from a customer walking in to an insight coming out.
 *
 * Drawn as a single connected run rather than six feature boxes, because the
 * argument of the product is the *connection*: a shop already records all of
 * this, just in separate places that never talk. Horizontal on wide screens,
 * vertical on a phone; the connector is a border on the container so it never
 * breaks between items.
 */

const STEPS = [
  { key: 'customer', icon: Users, label: 'Customer', body: 'Scan their code. Their whole history opens.' },
  { key: 'sales', icon: Receipt, label: 'Transactions', body: 'Say the sale out loud, check it, save it.' },
  { key: 'inventory', icon: Boxes, label: 'Inventory', body: 'Stock moves on its own as things sell.' },
  { key: 'payments', icon: Wallet, label: 'Payments', body: 'Udhaar is tracked, not remembered.' },
  { key: 'memory', icon: Brain, label: 'Shop Memory', body: 'Every entry becomes something to ask about.' },
  { key: 'insight', icon: Sparkles, label: 'AI insight', body: 'What needs doing today, grounded in your rows.' },
] as const;

export function HowItWorks({ className }: { className?: string }) {
  return (
    <div className={cn('grid gap-3 sm:grid-cols-2 lg:grid-cols-3', className)}>
      {STEPS.map((step, index) => (
        <FadeIn key={step.key} delay={index * 0.05}>
          {/*
            Lavender, and it lifts under the cursor.

            On white these six read as one grey block — six identical cards in
            a grid stop being six things and become texture. The tint separates
            the row from the page, and the lift is what tells someone they are
            arrows, not paragraphs.
          */}
          <div className="group relative flex h-full gap-3.5 rounded-[var(--radius-card)] bg-[var(--color-lavender)] p-4 ring-1 ring-transparent transition-[transform,box-shadow,background-color] duration-200 hover:-translate-y-1.5 hover:bg-[var(--color-surface)] hover:ring-2 hover:ring-[var(--color-primary)]/35 hover:shadow-[0_18px_40px_-12px_rgb(43_36_57_/_0.22)]">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-surface)]/70 text-[var(--color-primary)] transition-[background-color,transform] duration-200 group-hover:scale-110 group-hover:bg-[var(--color-lavender)]">
              <step.icon className="size-[18px]" aria-hidden="true" />
            </span>

            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="text-sm font-bold text-[var(--color-ink)]">{step.label}</p>
                {index < STEPS.length - 1 ? (
                  <ArrowRight
                    className="size-3 text-[var(--color-primary)]/50 transition-transform duration-200 group-hover:translate-x-0.5"
                    aria-hidden="true"
                  />
                ) : null}
              </div>
              <p className="mt-1 text-sm leading-relaxed text-[var(--color-ink-soft)]/85">{step.body}</p>
            </div>

            {/* Step number, set back far enough to read as texture. */}
            <span
              className="absolute top-3 right-4 text-xs font-bold text-[var(--color-primary)]/35 tabular"
              aria-hidden="true"
            >
              {String(index + 1).padStart(2, '0')}
            </span>
          </div>
        </FadeIn>
      ))}
    </div>
  );
}
