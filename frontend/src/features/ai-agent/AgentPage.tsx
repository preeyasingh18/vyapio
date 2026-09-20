import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowUp,
  Check,
  CircleDashed,
  Info,
  Loader2,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react';
import { PageBody, PageHeader } from '@/components/layout/PageHeader';
import { Button, Card, Input, Panel, SectionHeader } from '@/components/ui';
import { LogoMark } from '@/components/brand/Logo';
import { PageTransition } from '@/components/motion';
import { useT, useI18n } from '@/app/providers/I18nProvider';
import { useToast } from '@/app/providers/ToastProvider';
import { useQuery } from '@/hooks/useApi';
import { api, ApiError } from '@/lib/api';
import { formatMoney, formatTimelineDate } from '@/lib/format';
import type { AgentExecution, AgentRun, AgentStep } from '@shared/ai';
import { cn } from '@/lib/cn';

/**
 * Vyapio AI — the agent.
 *
 * Two things this screen exists to make visible:
 *
 *   **What it did.** Every tool call is shown as a step with its result, so the
 *   answer is never a black box.
 *
 *   **What it is about to do.** A side effect appears as a proposal listing
 *   each individual effect, with the delivery reality stated *before* the
 *   confirm button — including, when no provider is configured, that nothing
 *   will actually be sent.
 */

type RunResponse = { run: AgentRun };
type ConfirmResponse = { execution: AgentExecution };

export default function AgentPage() {
  const t = useT();
  const { locale } = useI18n();
  const toast = useToast();

  const [instruction, setInstruction] = useState('');
  const [run, setRun] = useState<AgentRun | null>(null);
  const [execution, setExecution] = useState<AgentExecution | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const { data: suggestions } = useQuery<{ suggestions: string[] }>('/agent/suggestions');
  const { data: history, refetch: refetchHistory } = useQuery<{
    actions: Array<{
      actionId: string;
      actionType: string;
      status: string;
      createdAt: string;
      input: Record<string, unknown>;
    }>;
  }>('/agent/actions');

  const go = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;

    setBusy(true);
    setRun(null);
    setExecution(null);
    setInstruction('');

    try {
      const result = await api.post<RunResponse>('/agent/run', { instruction: trimmed });
      setRun(result.run);
      void refetchHistory();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : t('errors.generic'));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!run?.proposal) return;
    setConfirming(true);
    try {
      const result = await api.post<ConfirmResponse>('/agent/confirm', {
        actionId: run.proposal.actionId,
      });
      setExecution(result.execution);

      // The toast repeats the server's own wording — it is the only source of
      // truth about what was actually delivered.
      const delivered = result.execution.results.filter((entry) => entry.ok).length;
      if (delivered > 0) toast.success(result.execution.message);
      else toast.info(result.execution.message);

      void refetchHistory();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : t('errors.generic'));
    } finally {
      setConfirming(false);
    }
  };

  const cancel = async () => {
    if (!run?.proposal) return;
    try {
      const result = await api.post<ConfirmResponse>('/agent/cancel', {
        actionId: run.proposal.actionId,
      });
      setExecution(result.execution);
      toast.info(result.execution.message);
      void refetchHistory();
    } catch {
      // Cancelling is advisory; clearing the proposal locally is enough.
      setRun({ ...run, proposal: null });
    }
  };

  return (
    <PageTransition>
      <PageHeader title={t('agent.title')} />

      <PageBody className="pb-32">
        {!run && !busy ? (
          <div className="pt-2 pb-6">
            <div className="flex items-center gap-3">
              <LogoMark size={40} />
              <div>
                <h2 className="text-xl font-bold tracking-tight text-[var(--color-ink)]">
                  {t('agent.greeting')}
                </h2>
                <p className="mt-0.5 text-sm text-[var(--color-muted)]">{t('agent.subtitle')}</p>
              </div>
            </div>

            <p className="mt-4 max-w-md text-sm leading-relaxed text-[var(--color-muted)]">
              {t('agent.explainer')}
            </p>
          </div>
        ) : null}

        {/* Starter prompts.
            These come from the server, computed against this shop's own data —
            they are the questions worth asking here, not a generic list. */}
        {suggestions && !run && !busy ? (
          <section>
            <SectionHeader title={t('agent.suggestions')} />
            <div className="grid gap-2 sm:grid-cols-2">
              {suggestions.suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => void go(suggestion)}
                  className="group flex items-center gap-2.5 rounded-[var(--radius-field)] border border-[var(--color-line)] bg-[var(--color-surface)] px-3.5 py-3 text-left text-sm text-[var(--color-ink-soft)] transition-colors hover:border-[var(--color-line-strong)] hover:bg-[var(--color-sunken)]"
                >
                  <Sparkles
                    className="size-4 shrink-0 text-[var(--color-primary)]"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">{suggestion}</span>
                  <ArrowUp
                    className="size-3.5 shrink-0 rotate-45 text-[var(--color-faint)] opacity-0 transition-opacity group-hover:opacity-100"
                    aria-hidden="true"
                  />
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {busy ? (
          <Panel inset className="flex items-center gap-3">
            <LogoMark size={40} pulse />
            <p className="text-sm font-semibold text-[var(--color-ink)]">
              {t('agent.understanding')}
            </p>
          </Panel>
        ) : null}

        <AnimatePresence>
          {run ? (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-4"
            >
              <p className="rounded-[var(--radius-card)] rounded-br-sm bg-[var(--color-primary)] px-4 py-2.5 text-sm font-medium text-[var(--color-primary-ink)]">
                {run.instruction}
              </p>

              {/* The transparency panel. */}
              <Panel inset>
                <SectionHeader title={t('agent.steps')} className="mb-0" />
                <ol className="mt-3 space-y-2.5">
                  {run.steps.map((step) => (
                    <StepRow key={step.id} step={step} />
                  ))}
                </ol>

                <p className="mt-4 border-t border-[var(--color-line)] pt-3 text-sm leading-relaxed text-[var(--color-ink)]">
                  {run.message}
                </p>

                {/* Where to go next.
                    A shopkeeper with a customer waiting will not type a
                    follow-up, so an answer that ends with nothing to tap is
                    where the conversation stops. These come from the server,
                    picked from what this answer actually looked up. */}
                {run.followUps.length > 0 && !run.proposal ? (
                  <div className="mt-4 border-t border-[var(--color-line)] pt-3">
                    <p className="text-[11px] font-bold tracking-wide text-[var(--color-muted)] uppercase">
                      {t('agent.askNext')}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {run.followUps.map((followUp) => (
                        <button
                          key={followUp}
                          type="button"
                          disabled={busy}
                          onClick={() => void go(followUp)}
                          className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium text-[var(--color-ink-soft)] transition-colors hover:border-[var(--color-line-strong)] hover:bg-[var(--color-sunken)] disabled:opacity-50"
                        >
                          <Sparkles
                            className="size-3 shrink-0 text-[var(--color-primary)]"
                            aria-hidden="true"
                          />
                          {followUp}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                <p className="mt-2 text-[11px] text-[var(--color-faint)]">
                  {run.engine === 'agentcore'
                    ? 'Planned by Amazon Bedrock AgentCore'
                    : run.engine === 'bedrock-tools'
                      ? 'Planned by Amazon Bedrock'
                      : 'Planned by Vyapio without AI'}
                </p>
              </Panel>

              {/* Evidence, same contract as Shop Memory. */}
              {run.citations.length > 0 ? (
                <div className="space-y-1.5">
                  <SectionHeader title={t('memory.sources')} className="mb-0" />
                  {run.citations.slice(0, 8).map((citation) => {
                    const body = (
                      <div className="flex items-center gap-3 rounded-[var(--radius-control)] border border-[var(--color-line)] bg-[var(--color-surface)] p-2.5">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-semibold text-[var(--color-ink)]">
                            {citation.label}
                          </p>
                          <p className="truncate text-[11px] text-[var(--color-muted)]">
                            {citation.detail}
                          </p>
                        </div>
                        {citation.amount !== undefined ? (
                          <span className="shrink-0 text-xs font-bold text-[var(--color-ink)] tabular">
                            {formatMoney(citation.amount)}
                          </span>
                        ) : null}
                      </div>
                    );
                    return citation.href ? (
                      <Link key={citation.id} to={citation.href} className="block">
                        {body}
                      </Link>
                    ) : (
                      <div key={citation.id}>{body}</div>
                    );
                  })}
                </div>
              ) : null}

              {/* The confirmation gate. */}
              {run.proposal && !execution ? (
                <Card className="overflow-hidden border-[var(--color-accent)]">
                  <div className="bg-[var(--color-accent-soft)] px-4 py-3">
                    <p className="text-sm font-bold text-[var(--color-accent)]">
                      {t('agent.aboutToDo')}
                    </p>
                    <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
                      {run.proposal.summary}
                    </p>
                  </div>

                  <ul className="divide-y divide-[var(--color-line)]">
                    {run.proposal.effects.map((effect, index) => (
                      <li
                        key={index}
                        className="px-4 py-2.5 text-sm text-[var(--color-ink-soft)]"
                      >
                        {effect}
                      </li>
                    ))}
                  </ul>

                  {/* Delivery reality, stated before the button. */}
                  <div className="flex gap-2.5 border-t border-[var(--color-line)] bg-[var(--color-sunken)] px-4 py-3">
                    <Info
                      className="mt-0.5 size-4 shrink-0 text-[var(--color-muted)]"
                      aria-hidden="true"
                    />
                    <p className="text-xs leading-snug text-[var(--color-muted)]">
                      {run.proposal.deliveryNote}
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-2 border-t border-[var(--color-line)] p-3">
                    <Button variant="outline" size="md" onClick={() => void cancel()}>
                      {run.proposal.cancelLabel}
                    </Button>
                    <Button
                      variant="accent"
                      size="md"
                      loading={confirming}
                      onClick={() => void confirm()}
                      icon={<Check className="size-4" />}
                    >
                      {run.proposal.confirmLabel}
                    </Button>
                  </div>
                </Card>
              ) : null}

              {/* Per-recipient outcome. Never a blanket "sent". */}
              {execution ? (
                <Card className="overflow-hidden">
                  <div
                    className={cn(
                      'px-4 py-3',
                      execution.results.some((entry) => entry.ok)
                        ? 'bg-[var(--color-success-soft)]'
                        : 'bg-[var(--color-sunken)]',
                    )}
                  >
                    <p
                      className={cn(
                        'text-sm font-bold',
                        execution.results.some((entry) => entry.ok)
                          ? 'text-[var(--color-success)]'
                          : 'text-[var(--color-ink-soft)]',
                      )}
                    >
                      {execution.message}
                    </p>
                  </div>

                  {execution.results.length > 0 ? (
                    <ul className="divide-y divide-[var(--color-line)]">
                      {execution.results.map((result, index) => (
                        <li key={index} className="flex gap-2.5 px-4 py-2.5">
                          {result.ok ? (
                            <Check
                              className="mt-0.5 size-4 shrink-0 text-[var(--color-success)]"
                              aria-hidden="true"
                            />
                          ) : (
                            <TriangleAlert
                              className="mt-0.5 size-4 shrink-0 text-[var(--color-warning)]"
                              aria-hidden="true"
                            />
                          )}
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-[var(--color-ink)]">
                              {result.label}
                            </p>
                            <p className="text-xs leading-snug text-[var(--color-muted)]">
                              {result.detail}
                            </p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </Card>
              ) : null}
            </motion.div>
          ) : null}
        </AnimatePresence>

        {/* Audit trail. */}
        {history && history.actions.length > 0 && !run ? (
          <section className="mt-8">
            <SectionHeader title={t('agent.history')} />
            <Panel className="divide-y divide-[var(--color-line)]">
              {history.actions.slice(0, 8).map((action) => (
                <div key={action.actionId} className="flex items-center gap-3 p-3">
                  <span
                    className={cn(
                      'size-1.5 shrink-0 rounded-full',
                      action.status === 'executed'
                        ? 'bg-[var(--color-success)]'
                        : action.status === 'cancelled'
                          ? 'bg-[var(--color-faint)]'
                          : 'bg-[var(--color-warning)]',
                    )}
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-semibold text-[var(--color-ink)]">
                      {String(action.input.instruction ?? action.actionType)}
                    </p>
                    <p className="text-[11px] text-[var(--color-muted)]">
                      {formatTimelineDate(action.createdAt, locale)} · {action.status}
                    </p>
                  </div>
                </div>
              ))}
            </Panel>
          </section>
        ) : null}
      </PageBody>

      <div className="glass fixed inset-x-0 bottom-0 z-30 border-t border-[var(--color-line)] p-3 pb-[calc(env(safe-area-inset-bottom)+5.5rem)] lg:pb-3">
        <form
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void go(instruction);
          }}
          className="mx-auto flex max-w-6xl gap-2"
        >
          <Input
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder={t('agent.placeholder')}
            aria-label={t('agent.placeholder')}
            disabled={busy}
          />
          <Button
            type="submit"
            size="icon"
            className="size-12 shrink-0"
            disabled={!instruction.trim() || busy}
            loading={busy}
            aria-label={t('agent.run')}
          >
            {busy ? null : <ArrowUp className="size-5" aria-hidden="true" />}
          </Button>
        </form>
      </div>
    </PageTransition>
  );
}

function StepRow({ step }: { step: AgentStep }) {
  const icon =
    step.status === 'done' ? (
      <Check className="size-4 text-[var(--color-success)]" aria-hidden="true" />
    ) : step.status === 'running' ? (
      <Loader2 className="size-4 animate-spin text-[var(--color-primary)]" aria-hidden="true" />
    ) : step.status === 'failed' ? (
      <X className="size-4 text-[var(--color-danger)]" aria-hidden="true" />
    ) : (
      <CircleDashed className="size-4 text-[var(--color-faint)]" aria-hidden="true" />
    );

  return (
    <li className="flex gap-2.5">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-[var(--color-ink)]">{step.label}</p>
        {step.detail ? (
          <p className="mt-0.5 text-xs leading-snug text-[var(--color-muted)]">{step.detail}</p>
        ) : null}
      </div>
    </li>
  );
}
