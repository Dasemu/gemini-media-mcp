import { audit } from "./log.js";
import { providerStatus } from "./log.js";

export function isTransient(error: unknown): boolean {
  const status = providerStatus(error);
  if (status === 429 || (status !== undefined && status >= 500)) return true;
  if (error instanceof Error) {
    return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|network/i.test(error.message);
  }
  return false;
}

export async function withRetry<T>(operation: string, fn: () => Promise<T>, maxRetries = 2): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error) {
      if (!isTransient(error) || attempt >= maxRetries) throw error;
      attempt += 1;
      const delayMs = Math.min(4000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
      audit("provider_retry", { operation, attempt, maxRetries, delayMs, providerStatus: providerStatus(error) });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
