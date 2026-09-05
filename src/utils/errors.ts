export interface ErrorDetails {
  human: string;
  raw: string;
}

const stringifyRawError = (error: unknown): string => {
  if (error instanceof Error) {
    const details: Record<string, unknown> = {};
    for (const key of Object.keys(error)) details[key] = (error as unknown as Record<string, unknown>)[key];
    if (error.cause !== undefined) details.cause = error.cause;
    const extra = Object.keys(details).length > 0 ? `\nDetails: ${safeJson(details)}` : '';
    return `${error.stack || `${error.name}: ${error.message}`}${extra}`;
  }

  if (typeof error === 'string') return error;
  if (error == null) return 'Unknown error';
  return safeJson(error);
};

const safeJson = (value: unknown): string => {
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
};

const extractMessage = (error: unknown): string | null => {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return null;
};

/** Keeps the user-facing explanation separate from the diagnostic payload. */
export const createErrorDetails = (
  error: unknown,
  humanMessage = 'Something went wrong.'
): ErrorDetails => ({
  human: extractMessage(error) || humanMessage,
  raw: stringifyRawError(error),
});

export const createRawErrorDetails = (
  rawError: unknown,
  humanMessage: string
): ErrorDetails => ({
  human: humanMessage,
  raw: stringifyRawError(rawError),
});

export const createUserErrorDetails = (message: string): ErrorDetails => ({
  human: message,
  raw: message,
});

export const errorDialogMessage = (details: ErrorDetails): string =>
  `${details.human}\n\nRaw error:\n${details.raw}`;
