import { type z } from 'zod';
import { validationFailed, type FieldIssue } from '../utils/errors';
import type { RequestContext } from '../utils/router';

/**
 * Input validation.
 *
 * Every handler parses its input through a Zod schema before doing anything
 * else, so a handler only ever sees a fully-typed, fully-checked value. Zod
 * issues are translated into field-level messages the form can render inline
 * rather than a generic "invalid request".
 */

function toIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '_',
    message: issue.message,
  }));
}

/** Parses and validates the JSON body. */
export function parseBody<S extends z.ZodType>(ctx: RequestContext, schema: S): z.infer<S> {
  const result = schema.safeParse(ctx.body ?? {});
  if (!result.success) throw validationFailed(toIssues(result.error));
  return result.data;
}

/** Parses and validates the query string. */
export function parseQuery<S extends z.ZodType>(ctx: RequestContext, schema: S): z.infer<S> {
  const result = schema.safeParse(ctx.query);
  if (!result.success) throw validationFailed(toIssues(result.error));
  return result.data;
}

/** Parses and validates path parameters. */
export function parseParams<S extends z.ZodType>(ctx: RequestContext, schema: S): z.infer<S> {
  const result = schema.safeParse(ctx.params);
  if (!result.success) throw validationFailed(toIssues(result.error));
  return result.data;
}

/**
 * Validates data on its way *out* of an AI boundary.
 *
 * Used where a model's output must conform before it can be returned or acted
 * on. Failure is a server-side problem, not a user input error, so it is logged
 * with the failing paths and reported as an AI availability issue.
 */
export function parseAiOutput<S extends z.ZodType>(
  schema: S,
  value: unknown,
  ctx: RequestContext,
  operation: string,
): z.infer<S> | null {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  ctx.logger.warn('AI output failed schema validation', {
    operation,
    issues: result.error.issues.map((issue) => issue.path.join('.')),
  });
  return null;
}
