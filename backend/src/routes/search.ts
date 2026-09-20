import { Router, ok } from '../utils/router';
import { parseBody } from '../middleware/validation';
import { requireVendor } from '../middleware/auth';
import { answerQuestion, isKnowledgeBaseEnabled } from '../services/knowledgeBase';
import { isBedrockEnabled } from '../services/bedrock';
import { SearchRequestSchema } from '../schemas/requests';

/**
 * Shop Memory — "Ask your shop anything…".
 *
 * All the work is in services/knowledgeBase.ts. The contract this route
 * upholds is that `grounded: false` is returned honestly, with an empty
 * citation list, rather than dressed up as an answer.
 */

export const searchRoutes = new Router();

/** Starter prompts for the empty state. Ordered by how well they demo. */
const SUGGESTIONS = [
  'Who owes me money?',
  'What did Ramesh buy last month?',
  'Who bought rice and oil together?',
  'How much did I sell this week?',
  'Which customers have pending payments?',
  'When did Ramesh last buy detergent?',
];

searchRoutes.get('/suggestions', async (ctx) => {
  await requireVendor(ctx);
  return ok({
    suggestions: SUGGESTIONS,
    engine: isKnowledgeBaseEnabled()
      ? 'knowledge-base'
      : isBedrockEnabled()
        ? 'bedrock'
        : 'local-retrieval',
  });
});

searchRoutes.post('/', async (ctx) => {
  const { vendorId } = await requireVendor(ctx);
  const input = parseBody(ctx, SearchRequestSchema);

  const answer = await answerQuestion({
    vendorId,
    question: input.question,
    ...(input.customerId ? { scopedCustomerId: input.customerId } : {}),
  });

  ctx.logger.info('shop memory queried', {
    operation: 'search.ask',
    vendorId,
    grounded: answer.grounded,
    citationCount: answer.citations.length,
    engine: answer.engine,
  });

  return ok({ result: answer });
});
