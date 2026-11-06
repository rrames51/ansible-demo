import { startVitest } from 'vitest/node';
import * as path from 'node:path';
import { logger } from './logger.ts';

try {
  const testFile = path.join(process.cwd(), 'scripts', 'test-http.ts');
  const vitest = await startVitest(
    'test',
    [testFile],
    {
      run: true,
      watch: false,
      include: [path.relative(process.cwd(), testFile)],
      hookTimeout: Number(process.env.READY_TIMEOUT_MS ?? '120000') + 5000,
      testTimeout: 30000,
    },
    { root: process.cwd() },
  );
  await vitest.close();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`[test] FAILED: ${message}`);
  process.exitCode = 1;
}
