import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowUp, FileText, Receipt, Search, User, Wallet } from 'lucide-react';
import { PageBody, PageHeader } from '@/components/layout/PageHeader';
import { Button, Card, Input, Panel, SectionHeader } from '@/components/ui';
import { LogoMark } from '@/components/brand/Logo';
import { PageTransition, Stagger, StaggerItem } from '@/components/motion';
import { useT, useI18n } from '@/app/providers/I18nProvider';
import { useQuery } from '@/hooks/useApi';
import { api, ApiError } from '@/lib/api';
import { formatMoney, formatTimelineDate } from '@/lib/format';
import type { Citation, MemoryAnswer } from '@shared/ai';

/**
 * Shop Memory.
 *
 * The rule this screen enforces visually: **no answer without evidence.** Every
 * grounded reply is followed by the actual records it was drawn from, each one
 * a link to the row it came from. When retrieval finds nothing, the screen says
 * so plainly instead of showing a confident sentence with nothing behind it.
 */

type SearchResponse = { result: MemoryAnswer };

/**
 * What the memory is made of.
 *
 * Listed explicitly because the honest claim is narrow: Vyapio remembers the
 * rows this shop has entered. Saying so beats a vague promise of intelligence,
 * and it sets the expectation that answers will cite those rows.
 */
const HOLDINGS = [
  { key: 'customers', icon: User, labelKey: 'memory.holdsCustomers', bodyKey: 'memory.holdsCustomersBody' },
  { key: 'purchases', icon: Receipt, labelKey: 'memory.holdsPurchases', bodyKey: 'memory.holdsPurchasesBody' },
  { key: 'payments', icon: Wallet, labelKey: 'memory.holdsPayments', bodyKey: 'memory.holdsPaymentsBody' },
  { key: 'documents', icon: FileText, labelKey: 'memory.holdsDocuments', bodyKey: 'memory.holdsDocumentsBody' },
] as const;

type Entry = {
  id: string;
  question: string;
  answer: MemoryAnswer | null;
  error: string | null;
};

export default function MemoryPage() {
  const t = useT();
  const { locale } = useI18n();

  const [question, setQuestion] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);

  const { data: suggestionsData } = useQuery<{ suggestions: string[]; engine: string }>(
    '/search/suggestions',
  );

  const ask = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;

    const id = crypto.randomUUID();
    setEntries((current) => [{ id, question: trimmed, answer: null, error: null }, ...current]);
    setQuestion('');
    setBusy(true);

    try {
      const result = await api.post<SearchResponse>('/search', { question: trimmed });
      setEntries((current) =>
        current.map((entry) => (entry.id === id ? { ...entry, answer: result.result } : entry)),
      );
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : t('errors.generic');
      setEntries((current) =>
        current.map((entry) => (entry.id === id ? { ...entry, error: message } : entry)),
      );
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void ask(question);
  };

  return (
    <PageTransition>
      <PageHeader title={t('memory.title')} />

      <PageBody className="pb-32">
        {entries.length === 0 ? (
          <>
            <div className="pt-2 pb-5">
              <div className="flex items-center gap-3">
                <LogoMark size={40} />
                <div>
                  <h2 className="text-xl font-bold tracking-tight text-[var(--color-ink)]">
                    {t('memory.heading')}
                  </h2>
                  <p className="mt-0.5 text-sm text-[var(--color-muted)]">{t('memory.strapline')}</p>
                </div>
              </div>
              <p className="mt-4 max-w-md text-sm leading-relaxed text-[var(--color-muted)]">
                {t('memory.grounding')}
              </p>
            </div>

            {/* What is actually in the memory.
                Naming the material is what separates this from a chat box —
                it says the answers are drawn from these rows and nothing else. */}
            <section>
              <SectionHeader title={t('memory.whatItHolds')} />
              <Panel className="divide-y divide-[var(--color-line)] px-4 sm:px-5">
                {HOLDINGS.map((holding) => (
                  <div key={holding.key} className="flex items-center gap-3 py-3">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-sunken)] text-[var(--color-primary)]">
                      <holding.icon className="size-4" aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-[var(--color-ink)]">
                        {t(holding.labelKey)}
                      </p>
                      <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                        {t(holding.bodyKey)}
                      </p>
                    </div>
                  </div>
                ))}
              </Panel>
            </section>
          </>
        ) : null}

        {/* Suggestions stay visible: they teach what the feature can do. */}
        {suggestionsData && entries.length === 0 ? (
          <section className="mt-6">
            <SectionHeader title={t('memory.suggestions')} />
            <div className="grid gap-2 sm:grid-cols-2">
              {suggestionsData.suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => void ask(suggestion)}
                  className="flex w-full items-center gap-2.5 rounded-[var(--radius-field)] border border-[var(--color-line)] bg-[var(--color-surface)] px-3.5 py-3 text-left text-sm text-[var(--color-ink-soft)] transition-colors hover:border-[var(--color-line-strong)] hover:bg-[var(--color-sunken)]"
                >
                  <Search className="size-4 shrink-0 text-[var(--color-faint)]" aria-hidden="true" />
                  <span className="min-w-0 flex-1">{suggestion}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <Stagger className="space-y-5">
          <AnimatePresence initial={false}>
            {entries.map((entry) => (
              <StaggerItem key={entry.id}>
                <AnswerBlock entry={entry} locale={locale} />
              </StaggerItem>
            ))}
          </AnimatePresence>
        </Stagger>
      </PageBody>

      {/* Sticky composer: the question box is the whole interface. */}
      <div className="glass fixed inset-x-0 bottom-0 z-30 border-t border-[var(--color-line)] p-3 pb-[calc(env(safe-area-inset-bottom)+5.5rem)] lg:pb-3">
        <form onSubmit={submit} className="mx-auto flex max-w-6xl gap-2">
          <Input
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder={t('memory.placeholder')}
            aria-label={t('memory.placeholder')}
            disabled={busy}
          />
          <Button
            type="submit"
            size="icon"
            className="size-12 shrink-0"
            disabled={!question.trim() || busy}
            loading={busy}
            aria-label={t('memory.ask')}
          >
            {busy ? null : <ArrowUp className="size-5" aria-hidden="true" />}
          </Button>
        </form>
      </div>
    </PageTransition>
  );
}

function AnswerBlock({ entry, locale }: { entry: Entry; locale: string }) {
  const t = useT();

  return (
    <div>
      {/* The question, as asked. */}
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-[var(--radius-card)] rounded-br-md bg-[var(--color-primary)] px-4 py-2.5 text-sm font-medium text-[var(--color-primary-ink)]">
          {entry.question}
        </p>
      </div>

      <div className="mt-3 flex gap-3">
        <LogoMark size={26} pulse={!entry.answer} className="mt-1" />

        <div className="min-w-0 flex-1">
          {entry.error ? (
            <Card className="border-[var(--color-danger)] p-4">
              <p className="text-sm text-[var(--color-danger)]">{entry.error}</p>
            </Card>
          ) : !entry.answer ? (
            <motion.p
              animate={{ opacity: [0.4, 1, 0.4] }}
              transition={{ duration: 1.4, repeat: Infinity }}
              className="py-2 text-sm text-[var(--color-muted)]"
            >
              {t('memory.thinking')}
            </motion.p>
          ) : (
            <>
              <Card
                className={
                  entry.answer.grounded ? 'p-4' : 'border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-4'
                }
              >
                <p className="text-sm leading-relaxed whitespace-pre-line text-[var(--color-ink)]">
                  {entry.answer.answer}
                </p>

                {!entry.answer.grounded ? (
                  <p className="mt-2 text-xs text-[var(--color-warning)]">
                    {t('memory.noAnswerBody')}
                  </p>
                ) : null}
              </Card>

              {/* Evidence. The reason to trust the sentence above. */}
              {entry.answer.citations.length > 0 ? (
                <div className="mt-3">
                  <p className="mb-2 text-xs font-bold tracking-wide text-[var(--color-muted)] uppercase">
                    {t('memory.sources')} · {entry.answer.citations.length}
                  </p>
                  <div className="space-y-1.5">
                    {entry.answer.citations.slice(0, 8).map((citation) => (
                      <CitationRow key={`${citation.kind}-${citation.id}`} citation={citation} locale={locale} />
                    ))}
                  </div>
                </div>
              ) : null}

              <p className="mt-2 text-[11px] text-[var(--color-faint)]">
                {entry.answer.engine === 'bedrock'
                  ? 'Written by Amazon Bedrock from your records'
                  : entry.answer.engine === 'knowledge-base'
                    ? 'Retrieved with Bedrock Knowledge Bases'
                    : 'Answered from your records without AI'}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const CITATION_ICON = {
  transaction: Receipt,
  payment: Wallet,
  commitment: Wallet,
  order: FileText,
  customer: User,
  product: FileText,
} as const;

function CitationRow({ citation, locale }: { citation: Citation; locale: string }) {
  const Icon = CITATION_ICON[citation.kind];

  const body = (
    <div className="flex items-center gap-3 rounded-[var(--radius-field)] border border-[var(--color-line)] bg-[var(--color-surface)] p-2.5">
      <Icon className="size-4 shrink-0 text-[var(--color-faint)]" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-semibold text-[var(--color-ink)]">{citation.label}</p>
        <p className="truncate text-[11px] text-[var(--color-muted)]">
          {citation.detail}
          {citation.timestamp ? ` · ${formatTimelineDate(citation.timestamp, locale)}` : ''}
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
    <Link to={citation.href} className="block transition-transform active:scale-[0.99]">
      {body}
    </Link>
  ) : (
    body
  );
}
