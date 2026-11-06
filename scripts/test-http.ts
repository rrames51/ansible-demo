import { beforeAll, describe, expect, it } from 'vitest';

const appUrl = (process.env.APP_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const readyTimeoutMs = Number(process.env.READY_TIMEOUT_MS ?? '120000');
const pollMs = 2000;

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + readyTimeoutMs;
  let lastError = 'unknown';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${appUrl}/health`);
      if (response.ok) {
        return;
      }
      lastError = `health status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    const delay = Math.min(pollMs, Math.max(0, deadline - Date.now()));
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error(`app not ready within ${readyTimeoutMs}ms: ${lastError}`);
}

describe('HTTP API', () => {
  beforeAll(waitForReady, readyTimeoutMs + 5000);

  it('reports the app as healthy', async () => {
    const response = await fetch(`${appUrl}/health`);
    expect(response.status).toBe(200);
  });

  it('returns the Fibonacci result for valid input', async () => {
    const response = await fetch(`${appUrl}/fib?n=10`);
    expect(response.status).toBe(200);

    const contentType = response.headers.get('content-type') ?? '';
    expect(contentType).toContain('application/json');

    const json = await response.json() as { result?: number };
    expect(json.result).toBe(55);
  });

  it('rejects invalid Fibonacci input', async () => {
    const response = await fetch(`${appUrl}/fib?n=abc`);
    expect(response.status).toBe(400);
  });
});
