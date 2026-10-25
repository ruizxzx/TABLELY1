export function extractErrorMessage(error: unknown, fallback = 'An error occurred'): string {
  if (!error) return fallback;
  if (error instanceof Error) return error.message;
  if (typeof error === 'object') {
    const errObj = error as Record<string, unknown>;
    if (typeof errObj.message === 'string' && errObj.message.trim()) {
      return errObj.message;
    }
    if (typeof errObj.error === 'string' && errObj.error.trim()) {
      return errObj.error;
    }
    if (typeof errObj.details === 'string' && errObj.details.trim()) {
      return errObj.details;
    }
    if (typeof errObj.hint === 'string' && errObj.hint.trim()) {
      return errObj.hint;
    }
  }
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}
