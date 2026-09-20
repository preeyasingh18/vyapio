/**
 * Error taxonomy.
 *
 * Two audiences, two messages. `message` is technical and goes to CloudWatch;
 * `userMessage` is the calm, non-technical sentence the shopkeeper sees. Raw
 * AWS exceptions never reach the client — `toAppError` funnels anything
 * unrecognised into a generic 500 and keeps the detail server-side.
 */

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'AI_UNAVAILABLE'
  | 'TRANSCRIBE_UNAVAILABLE'
  | 'TEXTRACT_UNAVAILABLE'
  | 'STORAGE_UNAVAILABLE'
  | 'DATABASE_UNAVAILABLE'
  | 'NOTIFICATION_FAILED'
  | 'NOT_CONFIGURED'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  AI_UNAVAILABLE: 503,
  TRANSCRIBE_UNAVAILABLE: 503,
  TEXTRACT_UNAVAILABLE: 503,
  STORAGE_UNAVAILABLE: 503,
  DATABASE_UNAVAILABLE: 503,
  NOTIFICATION_FAILED: 502,
  NOT_CONFIGURED: 501,
  INTERNAL: 500,
};

/** The sentence the user reads. Deliberately reassuring about data safety. */
const USER_MESSAGE: Record<ErrorCode, string> = {
  BAD_REQUEST: "That request didn't look right. Please try again.",
  VALIDATION_FAILED: 'Some details need fixing before we can save this.',
  UNAUTHENTICATED: 'Please sign in to continue.',
  FORBIDDEN: "You don't have access to this.",
  NOT_FOUND: "We couldn't find that.",
  CONFLICT: 'That already exists.',
  RATE_LIMITED: "That's a lot of requests. Give it a moment and try again.",
  PAYLOAD_TOO_LARGE: 'That file is too large.',
  AI_UNAVAILABLE: 'AI is temporarily unavailable. Your transaction is still safe.',
  TRANSCRIBE_UNAVAILABLE: "We couldn't hear that clearly. Try again.",
  TEXTRACT_UNAVAILABLE: "We couldn't read that document. Try again or enter it manually.",
  STORAGE_UNAVAILABLE: "We couldn't upload that right now. Please try again.",
  DATABASE_UNAVAILABLE: "We couldn't save this right now. Please try again.",
  NOTIFICATION_FAILED: "We couldn't send that message. Nothing else was changed.",
  NOT_CONFIGURED: 'That feature is not configured on this environment yet.',
  INTERNAL: 'Something went wrong on our side. Please try again.',
};

export type FieldIssue = { path: string; message: string };

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly userMessage: string;
  readonly issues: FieldIssue[];
  /** Extra context for logs only. Never serialised to the client. */
  readonly context: Record<string, unknown>;
  override readonly cause?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      userMessage?: string;
      issues?: FieldIssue[];
      context?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.userMessage = options.userMessage ?? USER_MESSAGE[code];
    this.issues = options.issues ?? [];
    this.context = options.context ?? {};
    this.cause = options.cause;
  }

  /** Client-safe shape. Deliberately omits `message`, `context` and `cause`. */
  toResponse(): { error: { code: ErrorCode; message: string; issues: FieldIssue[] } } {
    return { error: { code: this.code, message: this.userMessage, issues: this.issues } };
  }
}

export const badRequest = (message: string, userMessage?: string) =>
  new AppError('BAD_REQUEST', message, userMessage ? { userMessage } : {});

export const unauthenticated = (message = 'Missing or invalid session') =>
  new AppError('UNAUTHENTICATED', message);

export const forbidden = (message: string, context?: Record<string, unknown>) =>
  new AppError('FORBIDDEN', message, context ? { context } : {});

export const notFound = (what: string) =>
  new AppError('NOT_FOUND', `${what} not found`, { userMessage: `We couldn't find that ${what}.` });

export const conflict = (message: string, userMessage?: string) =>
  new AppError('CONFLICT', message, userMessage ? { userMessage } : {});

export const notConfigured = (feature: string) =>
  new AppError('NOT_CONFIGURED', `${feature} is not configured`, {
    userMessage: `${feature} is not configured on this environment yet.`,
  });

export const validationFailed = (issues: FieldIssue[]) =>
  new AppError('VALIDATION_FAILED', 'Schema validation failed', { issues });

/**
 * Normalises anything thrown anywhere into an AppError.
 *
 * AWS SDK errors are mapped by name onto the matching "service unavailable"
 * code so the user gets the reassuring sentence rather than, say,
 * "ThrottlingException: Rate exceeded".
 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  if (error instanceof Error) {
    const name = error.name;

    if (name === 'AccessDeniedException' || name === 'UnrecognizedClientException') {
      return new AppError('NOT_CONFIGURED', `AWS access denied: ${error.message}`, {
        userMessage:
          'This environment is missing permission for that AWS service. Nothing was changed.',
        cause: error,
      });
    }
    if (name === 'ThrottlingException' || name === 'TooManyRequestsException') {
      return new AppError('RATE_LIMITED', error.message, { cause: error });
    }
    if (name === 'ValidationException' || name === 'SerializationException') {
      return new AppError('BAD_REQUEST', error.message, { cause: error });
    }
    if (name === 'ConditionalCheckFailedException') {
      return new AppError('CONFLICT', error.message, {
        userMessage: 'Someone changed this at the same time. Please refresh and try again.',
        cause: error,
      });
    }
    if (name === 'ResourceNotFoundException') {
      return new AppError('NOT_CONFIGURED', error.message, {
        userMessage: 'A required AWS resource is missing on this environment.',
        cause: error,
      });
    }
    if (name === 'ProvisionedThroughputExceededException' || name.startsWith('DynamoDB')) {
      return new AppError('DATABASE_UNAVAILABLE', error.message, { cause: error });
    }
    if (name === 'ModelTimeoutException' || name === 'ModelNotReadyException') {
      return new AppError('AI_UNAVAILABLE', error.message, { cause: error });
    }

    return new AppError('INTERNAL', error.message, { cause: error });
  }

  return new AppError('INTERNAL', `Non-error thrown: ${String(error)}`);
}
