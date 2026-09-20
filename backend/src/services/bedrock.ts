import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type ToolInputSchema,
  type Message,
  type Tool,
} from '@aws-sdk/client-bedrock-runtime';
import { config } from '../config/index';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import { ExtractedTransactionSchema, EXTRACTED_TRANSACTION_TOOL_SCHEMA } from '../schemas/ai';
import type { JsonSchemaDocument } from '../schemas/ai';
import type { ExtractedTransaction } from '../schemas/ai';
import type { Language } from '../schemas/common';
import { languageMeta } from '../schemas/common';
import { parseTranscriptLocally, type LocalParseContext } from './localParser';

/**
 * Amazon Bedrock.
 *
 * Three uses, in descending order of how much is riding on the output:
 *
 *   1. Transaction parsing — speech into structured fields. Guarded by a Zod
 *      schema, cross-checked against the deterministic parser, and shown to a
 *      human before anything is written.
 *   2. Narration — turning numbers that were already computed in code into a
 *      sentence. Cosmetic: every caller renders correctly without it.
 *   3. Grounded answering — prose over records that retrieval already selected.
 *      The model may summarise them; it may not introduce facts.
 *
 * What Bedrock is never asked to do is arithmetic. `daysRemaining = stock /
 * velocity` is a division, and a division should be a division.
 */

/** The JSON-schema document the Converse API expects for a tool spec. */
type JsonSchema = ToolInputSchema.JsonMember['json'];

let client: BedrockRuntimeClient | null = null;

function bedrock(): BedrockRuntimeClient {
  if (!client) {
    client = new BedrockRuntimeClient({
      region: config.ai.region,
      maxAttempts: 3,
    });
  }
  return client;
}

export function isBedrockEnabled(): boolean {
  return config.ai.mode === 'aws';
}

/* ------------------------------------------------------------- Primitives */

/**
 * Structured output via tool use.
 *
 * Forcing a tool call is far more reliable than asking for JSON in prose: the
 * model cannot preface it with "Here is the JSON you asked for", and the field
 * names come from the schema rather than from the model's memory of it.
 */
async function invokeStructured<T>(input: {
  system: string;
  prompt: string;
  toolName: string;
  toolDescription: string;
  schema: Record<string, JsonSchemaDocument>;
  operation: string;
}): Promise<T> {
  const tool: Tool = {
    toolSpec: {
      name: input.toolName,
      description: input.toolDescription,
      inputSchema: { json: input.schema as JsonSchema },
    },
  };

  const startedAt = Date.now();
  try {
    const response = await bedrock().send(
      new ConverseCommand({
        modelId: config.ai.modelId,
        system: [{ text: input.system }],
        messages: [{ role: 'user', content: [{ text: input.prompt }] }] as Message[],
        toolConfig: {
          tools: [tool],
          // Leaves the model no option but to answer in the schema's shape.
          toolChoice: { tool: { name: input.toolName } },
        },
        inferenceConfig: { maxTokens: config.ai.maxTokens, temperature: 0 },
      }),
    );

    const blocks: ContentBlock[] = response.output?.message?.content ?? [];
    const toolUse = blocks.find((block) => 'toolUse' in block && block.toolUse)?.toolUse;
    if (!toolUse?.input) {
      throw new AppError('AI_UNAVAILABLE', 'Model returned no structured output');
    }

    logger.debug('bedrock structured call', {
      operation: input.operation,
      durationMs: Date.now() - startedAt,
      inputTokens: response.usage?.inputTokens,
      outputTokens: response.usage?.outputTokens,
    });

    return toolUse.input as T;
  } catch (error) {
    logger.error('bedrock structured call failed', {
      operation: input.operation,
      durationMs: Date.now() - startedAt,
      error,
    });
    throw error;
  }
}

/** Plain text generation, used only where the output is decorative. */
export async function invokeText(input: {
  system: string;
  prompt: string;
  operation: string;
  maxTokens?: number;
}): Promise<string> {
  const startedAt = Date.now();
  const response = await bedrock().send(
    new ConverseCommand({
      modelId: config.ai.modelId,
      system: [{ text: input.system }],
      messages: [{ role: 'user', content: [{ text: input.prompt }] }] as Message[],
      inferenceConfig: {
        maxTokens: input.maxTokens ?? config.ai.maxTokens,
        temperature: 0.2,
      },
    }),
  );

  logger.debug('bedrock text call', {
    operation: input.operation,
    durationMs: Date.now() - startedAt,
    inputTokens: response.usage?.inputTokens,
    outputTokens: response.usage?.outputTokens,
  });

  const blocks: ContentBlock[] = response.output?.message?.content ?? [];
  return blocks
    .map((block) => ('text' in block && block.text ? block.text : ''))
    .join('')
    .trim();
}

/* --------------------------------------------------- Transaction parsing */

const PARSE_SYSTEM = `You extract structured sales records from what an Indian shopkeeper says out loud.

The speech is usually Hinglish — Hindi grammar with English nouns — or a regional Indian language. Examples of what you will hear:
  "Ramesh ko 2 kilo chawal aur ek tel diya. 300 UPI kiya aur 120 baaki hai."  -> two items
  "Priya ne 500 ka saman liya, sab cash."
  "Arpita ko 4 liter doodh aur 3 chai ke packet chahiye, 200 de chuki hai."  -> two items

Rules you must follow:
- Extract EVERY product mentioned in the transcript. A single transaction can contain any number of products. Never stop after identifying the first product. Read the sentence to the end.
- Items are separated by "aur", "and", commas, or simply by a new quantity. "4 litre milk aur 3 tea packets" is TWO items; "2 kg rice, 3 milk, 4 tea packets aur 1 kg sugar" is FOUR.
- Include a product even if you doubt the shop stocks it. Whether it is in stock is decided later, from the shop's own inventory — your job is to report everything that was asked for.
- Translate product names to plain English ("chawal" -> "Rice", "tel" -> "Cooking Oil", "doodh" -> "Milk", "chai" -> "Tea").
- "baaki", "udhaar", "pending", "due" mean money still owed, NOT money paid.
- "diya", "kiya", "paid" near an amount mean money handed over.
- Amounts are rupees. Never invent an amount that was not spoken.
- If a price was not stated, use null. Do NOT guess prices.
- If you are unsure about any value, lower your confidence and list the specific doubt in "ambiguities" as a short question a shopkeeper could answer.
- Never invent a customer name. If none was spoken, use null.

Your output is shown to the shopkeeper for confirmation before anything is saved, so flagging doubt is always better than guessing.`;

export type ParseOptions = LocalParseContext & {
  language: Language;
};

/**
 * Parses a transcript into structured fields.
 *
 * When Bedrock is enabled both parsers run and their money fields are compared.
 * A disagreement does not pick a winner — it raises an ambiguity and drops the
 * confidence, so the preview asks the shopkeeper instead of silently choosing.
 */
export async function parseTransaction(
  transcript: string,
  options: ParseOptions,
): Promise<{ extracted: ExtractedTransaction; engine: 'bedrock' | 'local-parser' }> {
  const local = parseTranscriptLocally(transcript, options);

  if (!isBedrockEnabled()) {
    return { extracted: local, engine: 'local-parser' };
  }

  try {
    const meta = languageMeta(options.language);
    const context: string[] = [];
    if (options.customerNames?.length) {
      context.push(
        `Known customers at this shop: ${options.customerNames.slice(0, 60).join(', ')}.`,
      );
    }
    if (options.productNames?.length) {
      context.push(`Products this shop stocks: ${options.productNames.slice(0, 60).join(', ')}.`);
    }

    const raw = await invokeStructured<unknown>({
      system: PARSE_SYSTEM,
      prompt: [
        `The shopkeeper is speaking ${meta.label}.`,
        ...context,
        '',
        `Transcript: "${transcript}"`,
      ].join('\n'),
      toolName: 'record_transaction',
      toolDescription: 'Record the sale described in the transcript.',
      schema: EXTRACTED_TRANSACTION_TOOL_SCHEMA,
      operation: 'bedrock.parseTransaction',
    });

    // The schema is the gate. Malformed output falls through to the local
    // parser rather than reaching the domain layer.
    const parsed = ExtractedTransactionSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn('model output failed schema validation, using local parser', {
        operation: 'bedrock.parseTransaction',
        issues: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
      return {
        extracted: {
          ...local,
          ambiguities: [
            ...local.ambiguities,
            'The AI reply could not be read, so this was worked out locally. Please check it.',
          ],
        },
        engine: 'local-parser',
      };
    }

    return { extracted: reconcile(parsed.data, local), engine: 'bedrock' };
  } catch (error) {
    // Bedrock being down must never block recording a sale. Fall back and say so.
    logger.warn('bedrock unavailable, using local parser', {
      operation: 'bedrock.parseTransaction',
      error,
    });
    return {
      extracted: {
        ...local,
        ambiguities: [
          ...local.ambiguities,
          'AI is temporarily unavailable, so this was worked out locally. Please check the amounts.',
        ],
      },
      engine: 'local-parser',
    };
  }
}

/**
 * Flags every money field where the two parsers disagree.
 *
 * The model's value is kept — it handles phrasing the rule engine cannot — but
 * the disagreement is surfaced and confidence drops, which is what makes the
 * preview screen ask "I heard ₹480. Did you mean ₹580?" instead of guessing.
 */
function reconcile(model: ExtractedTransaction, local: ExtractedTransaction): ExtractedTransaction {
  const ambiguities = [...model.ambiguities];
  let confidence = model.confidence;

  const compare = (label: string, a: number | null, b: number | null) => {
    if (a === null || b === null) return;
    if (Math.abs(a - b) < 0.5) return;
    ambiguities.push(`We heard ₹${a} ${label}. Did you mean ₹${b}?`);
    confidence = Math.min(confidence, 0.5);
  };

  compare('paid', model.paidRupees, local.paidRupees);
  compare('pending', model.outstandingRupees, local.outstandingRupees);
  compare('as the total', model.totalRupees, local.totalRupees);

  if (model.items.length === 0 && local.items.length > 0) {
    confidence = Math.min(confidence, 0.5);
    ambiguities.push('We could not match the items confidently. Please check the list.');
  }

  return { ...model, ambiguities: ambiguities.slice(0, 6), confidence };
}

/* --------------------------------------------------------------- Narration */

const NARRATION_SYSTEM = `You write one short line of advice for an Indian shopkeeper, based on figures that have already been calculated.

Rules:
- Use only the numbers you are given. Never compute, adjust or invent a figure.
- One sentence, under 22 words, plain English a busy shopkeeper can read at a glance.
- Be concrete and actionable. No greetings, no preamble, no emoji.`;

/**
 * Turns computed metrics into a sentence.
 *
 * Returns null rather than throwing: narration is decoration on a card that is
 * already correct, so its absence should never surface as an error.
 */
export async function narrate(facts: string, operation: string): Promise<string | null> {
  if (!isBedrockEnabled()) return null;
  try {
    const text = await invokeText({
      system: NARRATION_SYSTEM,
      prompt: facts,
      operation,
      maxTokens: 120,
    });
    return text.length > 0 ? text : null;
  } catch (error) {
    logger.warn('narration unavailable', { operation, error });
    return null;
  }
}

/* ------------------------------------------------------- Grounded answering */

const GROUNDED_SYSTEM = `You answer an Indian shopkeeper's questions about their own shop records.

Absolute rules:
- Use ONLY the records provided. They are the complete evidence available.
- Never invent a customer, product, amount or date. Never estimate.
- If the records do not answer the question, reply with exactly: I couldn't find enough information in your shop records.
- Amounts are already formatted in rupees. Repeat them exactly as given.
- Answer in 1-3 short sentences. Lead with the direct answer.
- Do not mention "records provided", "context" or "data" — just answer naturally.`;

/**
 * Answers a question over records that retrieval has already selected.
 *
 * Returns null when Bedrock is unavailable; callers fall back to a
 * deterministic summary of the same records, so the answer stays grounded in
 * either case.
 */
export async function answerFromRecords(input: {
  question: string;
  records: string;
  operation: string;
}): Promise<string | null> {
  if (!isBedrockEnabled()) return null;
  try {
    const text = await invokeText({
      system: GROUNDED_SYSTEM,
      prompt: `Question: ${input.question}\n\nShop records:\n${input.records}`,
      operation: input.operation,
      maxTokens: 400,
    });
    return text.length > 0 ? text : null;
  } catch (error) {
    logger.warn('grounded answering unavailable', { operation: input.operation, error });
    return null;
  }
}

/** Test seam. */
export function setBedrockClient(next: BedrockRuntimeClient | null): void {
  client = next;
}
