import { execFileSync, execOrThrow } from './run.ts';
import {
  ensureLxd,
  launchContainer,
  waitForCloudInit,
  publishPublicKey,
  getContainerIpv4,
  waitForSsh,
  readContainerLogs,
  destroyContainer,
} from './lxd.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from './logger.ts';

interface RunState {
  readonly id: string;
  readonly containerName: string;
  readonly runDir: string;
  readonly keyPath: string;
  readonly inventoryPath: string;
}

function makeRunState(): RunState {
  const id = `${Date.now().toString(36)}-${process.pid}`;
  const runDir = path.join(process.cwd(), '.run', id);
  const keyPath = path.join(runDir, 'id_ed25519');
  const containerName = `node-express-inttest-${id.replace(/\./g, '-')}`.toLowerCase();
  return {
    id,
    containerName,
    runDir,
    keyPath,
    inventoryPath: path.join(runDir, 'hosts.ini'),
  };
}

function renderInventory(ip: string, state: RunState): string {
  const commonArgs = '-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null';
  return `[lxc]
${ip} ansible_host=${ip} ansible_port=22 ansible_user=ubuntu ansible_ssh_private_key_file=${state.keyPath} ansible_ssh_common_args="${commonArgs}"
`;
}

function readEnv(name: string, defaultValue: string): string {
  const value = process.env[name];
  return value == null || value === '' ? defaultValue : value;
}

async function main(): Promise<void> {
  const state = makeRunState();
  fs.mkdirSync(state.runDir, { recursive: true });

  let created = false;
  let failed = false;

  try {
    logger.log(`[inttest] run id ${state.id}`);
    logger.log('[inttest] ensuring LXD...');
    ensureLxd();

    logger.log('[inttest] generating SSH key...');
    execOrThrow('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', state.keyPath, '-q']);
    const publicKey = fs.readFileSync(`${state.keyPath}.pub`, 'utf8').trim();

    logger.log(`[inttest] launching container ${state.containerName}`);
    launchContainer(state.containerName);
    created = true;

    logger.log('[inttest] waiting for cloud-init...');
    waitForCloudInit(state.containerName);

    logger.log('[inttest] publishing SSH key...');
    publishPublicKey(state.containerName, publicKey);

    logger.log('[inttest] discovering container IP...');
    const ip = getContainerIpv4(state.containerName);
    logger.log(`[inttest] container IP ${ip}`);

    logger.log('[inttest] waiting for SSH...');
    waitForSsh(ip, state.keyPath);

    logger.log('[inttest] rendering inventory...');
    fs.writeFileSync(state.inventoryPath, renderInventory(ip, state));

    const extraVars = JSON.stringify({
      app_backend: 'native',
      app_name: 'node-express-app',
      app_port: 3000,
      app_log_level: readEnv('APP_LOG_LEVEL', 'info'),
    });

    logger.log('[inttest] deploying with Ansible...');
    execOrThrow('ansible-playbook', [
      '-i', state.inventoryPath,
      path.join(process.cwd(), 'playbooks', 'site.yml'),
      '--extra-vars', extraVars,
    ]);

    const appUrl = `http://${ip}:3000`;
    logger.log(`[inttest] APP_URL=${appUrl}`);

    logger.log('[inttest] running HTTP assertions...');
    const testResult = execFileSync('node', [path.join(process.cwd(), 'scripts', 'test-http-run.ts')], {
      env: { ...process.env, APP_URL: appUrl },
      timeout: 300000,
    });
    process.stdout.write(testResult.stdout);
    process.stderr.write(testResult.stderr);
    if (testResult.status !== 0) {
      throw new Error('integration tests failed');
    }

    logger.log('[inttest] PASS');
  } catch (error) {
    failed = true;
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[inttest] FAILED: ${message}`);
    if (created) {
      try {
        logger.error('[inttest] collecting container journal...');
        const logs = readContainerLogs(state.containerName);
        logger.error(logs);
      } catch (logError) {
        const logMessage = logError instanceof Error ? logError.message : String(logError);
        logger.error(`[inttest] diagnostics failed: ${logMessage}`);
      }
    }
    process.exitCode = 1;
  } finally {
    if (created) {
      try {
        logger.log('[inttest] destroying container...');
        destroyContainer(state.containerName);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[inttest] destroy failed: ${message}`);
        process.exitCode = 1;
      }
    }
    if (!failed) {
      fs.rmSync(state.runDir, { recursive: true, force: true });
    } else {
      logger.error(`[inttest] run artifacts retained at ${state.runDir}`);
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(message);
  process.exit(1);
});
