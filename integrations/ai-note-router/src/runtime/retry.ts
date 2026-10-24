export type RetryOptions = {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export async function retryAsync<T>(
  fn: (attempt: number) => Promise<T>,
  shouldRetry: (error: unknown, attempt: number) => boolean,
  options: RetryOptions
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= options.attempts || !shouldRetry(error, attempt)) {
        throw error;
      }

      const delay = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
      await wait(delay);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Retry attempts exhausted");
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
