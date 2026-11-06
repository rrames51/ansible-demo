import { execFileSync } from './run.ts';
import { ensureLxd } from './lxd.ts';
import { logger } from './logger.ts';

try {
  ensureLxd();
  const info = execFileSync('lxc', ['info'], {});
  logger.log(info.stdout.split('\n').slice(0, 12).join('\n'));
  logger.log('[ensure-lxd] OK');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`[ensure-lxd] FAILED: ${message}`);
  process.exit(1);
}
