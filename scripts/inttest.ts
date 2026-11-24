import { execFile } from './lib/run.ts';
import {
  ensureLxd,
  launchContainer,
  waitForCloudInit,
  publishPublicKey,
  getContainerIpv4,
  waitForSsh,
  readContainerLogs,
  configureTargetApt,
  destroyContainer,
} from './lib/lxd.ts';
import { probeAptCache } from './lib/apt-cache.ts';
import { createRunState, renderInventory, generateSshKey, type RunState } from './lib/target.ts';
import { runAnsiblePlaybook, printProfileRecap } from './lib/ansible.ts';
import { createStepTimer } from './lib/timing.ts';
import { createUi } from './lib/ui.ts';
import { seedTestDb } from './lib/seed-test-db.ts';
import { importUsers } from './lib/import-users.ts';
import { makeMysqlConfig } from './lib/mysql-config.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { logger } from './lib/logger.ts';
import { TEST_USERS } from './lib/test-users.ts';
import {
  parseScriptFlags,
  DEFAULT_SCRIPT_FLAGS,
  resolveOutputFlags,
  OUTPUT_FLAG_USAGE,
  UNSAFE_IO_DPKG_OPTIONS,
} from './lib/flags.ts';

const FLAG_USAGE = [
  'Usage: npm run inttest -- [options]',
  '',
  'Throwaway-target optimizations (never used by self.ts / production):',
  '  --unsafe-io / --no-unsafe-io  dpkg --force-unsafe-io during apt installs (default: on)',
  '  --tmpfs / --no-tmpfs          back the container rootfs with tmpfs (default: off)',
  '  --apt-cache / --no-apt-cache  use the local apt cache if one answers (default: on;',
  '                                falls back to direct mirror fetches when absent)',
  '',
  OUTPUT_FLAG_USAGE,
  '  --help',
].join('\n');

function readEnv(name: string, defaultValue: string): string {
  const value = process.env[name];
  return value == null || value === '' ? defaultValue : value;
}

function randomPassword(): string {
  return randomBytes(18).toString('base64url');
}

async function waitForKeycloakReady(
  url: string,
  timeoutMs: number,
  onStatus?: (status: string) => void,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'unknown';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = `readiness status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    onStatus?.(lastError);
    const delay = Math.min(2000, Math.max(0, deadline - Date.now()));
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error(`Keycloak not ready within ${timeoutMs}ms: ${lastError}`);
}

interface IdpRunContext {
  readonly keycloakUrl: string;
  readonly bootstrapPassword: string;
  readonly importerPassword: string;
  readonly testPasswordsJson: string;
}

/**
 * Workstation-side scripts (seed/import/rehash assertions) reach the target
 * machine's MySQL exactly the way an operator would against prod: over an SSH
 * local port-forward to 127.0.0.1:3306. MySQL itself stays loopback-bound and
 * remote-root-less — nothing in the deploy is loosened for tests.
 */
async function openMysqlTunnel(state: RunState, ip: string): Promise<{
  process: ChildProcess;
  localPort: number;
}> {
  // Grab a free local port race-free.
  const localPort = await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address == null || typeof address === 'string') {
        server.close();
        reject(new Error('could not allocate local tunnel port'));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.once('error', reject);
  });

  const tunnel = spawn(
    'ssh',
    [
      '-N',
      '-L', `127.0.0.1:${localPort}:127.0.0.1:3306`,
      '-i', state.keyPath,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'ExitOnForwardFailure=yes',
      `ubuntu@${ip}`,
    ],
    { stdio: 'ignore' },
  );

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port: localPort });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (open) {
      return { process: tunnel, localPort };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  tunnel.kill();
  throw new Error('MySQL SSH tunnel did not open within 30s');
}

async function main(): Promise<void> {
  const flags = parseScriptFlags(process.argv.slice(2), DEFAULT_SCRIPT_FLAGS, FLAG_USAGE, { perf: true });
  const output = resolveOutputFlags(flags);
  const ui = createUi({ prefix: 'inttest', rich: output.rich });
  const state = createRunState('node-express-inttest');
  fs.mkdirSync(state.runDir, { recursive: true });
  const timer = createStepTimer('inttest', ui);

  let created = false;
  let failed = false;

  try {
    ui.log(`[inttest] run id ${state.id}`);
    ui.log(`[inttest] flags: unsafe-io=${flags.unsafeIo ? 'on' : 'off'} tmpfs=${flags.tmpfs ? 'on' : 'off'}`);

    await timer.run('ensure LXD', () => ensureLxd());

    const aptCacheUrl = flags.aptCache
      ? await timer.run('probe apt cache', () => probeAptCache())
      : null;
    ui.log(
      `[inttest] apt cache: ${aptCacheUrl ?? (flags.aptCache ? 'unavailable, mirrors direct' : 'disabled by flag')}`,
    );

    const publicKey = await timer.run('generate SSH key', () => generateSshKey(state));

    await timer.run(`launch container ${state.containerName}`, (ctx) =>
      launchContainer(state.containerName, { tmpfs: flags.tmpfs, preview: ctx.preview }));
    created = true;

    await timer.run('wait for cloud-init', (ctx) =>
      waitForCloudInit(state.containerName, ctx.preview));

    await timer.run('configure target apt', () => configureTargetApt(state.containerName, aptCacheUrl));

    await timer.run('publish SSH key', () => publishPublicKey(state.containerName, publicKey));

    const ip = await timer.run('discover container IP', () => getContainerIpv4(state.containerName));
    ui.log(`[inttest] container IP ${ip}`);

    await timer.run('wait for SSH', (ctx) =>
      waitForSsh(ip, state.keyPath, (attempt) => ctx.setStatus(`attempt ${attempt}`)));

    await timer.run('render inventory', () => {
      fs.writeFileSync(state.inventoryPath, renderInventory(ip, state));
    });

    const idpEnabled = readEnv('INTTEST_IDP', '1') !== '0';

    const extraVarValues: Record<string, unknown> = {
      app_backend: 'native',
      app_name: 'node-express-app',
      app_port: 3000,
      app_log_level: readEnv('APP_LOG_LEVEL', 'info'),
    };

    // Throwaway target: skip dpkg's per-file fsync during unpack (roles keep
    // the stock, production-safe default; only these scripts opt in).
    if (flags.unsafeIo) {
      extraVarValues.apt_dpkg_options = UNSAFE_IO_DPKG_OPTIONS;
    }

    // Per-run IdP stack: MySQL (test datastore) + Keycloak, with generated
    // secrets that never outlive this run.
    let idpContext: IdpRunContext | null = null;
    if (idpEnabled) {
      const importerPassword = randomPassword();
      const keycloakDbPassword = randomPassword();
      const bootstrapPassword = randomPassword();
      const testPasswords: Record<string, string> = {};
      for (const user of TEST_USERS) {
        if (user.password) {
          testPasswords[user.email] = randomPassword();
        }
      }
      Object.assign(extraVarValues, {
        mysql_enabled: true,
        keycloak_enabled: true,
        mysql_databases: [{ name: 'dc' }, { name: 'keycloak' }],
        mysql_users: [
          {
            name: 'importer',
            host: 'localhost',
            password: importerPassword,
            priv: 'dc.*:ALL/keycloak.*:SELECT',
          },
          {
            name: 'keycloak',
            host: 'localhost',
            password: keycloakDbPassword,
            priv: 'keycloak.*:ALL',
          },
        ],
        keycloak_db_password: keycloakDbPassword,
        keycloak_bootstrap_admin_username: 'kcadmin',
        keycloak_bootstrap_admin_password: bootstrapPassword,
        keycloak_after_units: 'network.target mysql.service',
        keycloak_ssl_required: 'none',
      });
      idpContext = {
        keycloakUrl: `http://${ip}:8080`,
        bootstrapPassword,
        importerPassword,
        testPasswordsJson: JSON.stringify(testPasswords),
      };
    }

    const extraVars = JSON.stringify(extraVarValues);

    // Rich mode always streams Ansible into the task's live preview;
    // INTTEST_ANSIBLE_LIVE=1 does the same for plain mode by inheriting the
    // terminal. Otherwise the output is captured (full log in the run dir),
    // with just the per-task profile recap printed on success.
    const liveAnsible = readEnv('INTTEST_ANSIBLE_LIVE', '0') === '1';
    await timer.run('ansible-playbook site.yml', async (ctx) => {
      const stream = liveAnsible && ctx.preview == null;
      const result = await runAnsiblePlaybook({
        inventoryPath: state.inventoryPath,
        extraVars,
        stream,
        preview: ctx.preview,
        logPath: stream ? undefined : path.join(state.runDir, 'ansible.log'),
      });
      if (output.profile && !stream) {
        printProfileRecap(result.stdout, ui.log);
      }
    }, { previewLines: 8 });

    const appUrl = `http://${ip}:3000`;
    ui.log(`[inttest] APP_URL=${appUrl}`);

    await timer.run('HTTP assertions', async (ctx) => {
      const testResult = await execFile(
        'npx',
        ['vitest', 'run', 'test/test-http.test.ts'],
        {
          env: { ...process.env, APP_URL: appUrl },
          timeout: 300000,
          preview: ctx.preview,
        },
      );
      if (ctx.preview == null) {
        process.stdout.write(testResult.stdout);
        process.stderr.write(testResult.stderr);
      }
      if (testResult.status !== 0) {
        throw new Error('integration tests failed');
      }
    }, { previewLines: 12 });

    if (idpContext != null) {
      const idp = idpContext;
      // Measured on the workstation repro (Keycloak 26.8.2, fresh schema):
      // cold first boot ~250s (Liquibase DDL dominates), warm restart ~10s.
      // 600s leaves headroom for slower server disks; warm boots, the only
      // case that is real downtime, never come close.
      const readyTimeoutMs = Number(readEnv('KEYCLOAK_READY_TIMEOUT_MS', '600000'));

      await timer.run('wait for Keycloak readiness', (ctx) => {
        ctx.setStatus(`timeout ${Math.round(readyTimeoutMs / 1000)}s`);
        return waitForKeycloakReady(
          `http://${ip}:9000/health/ready`,
          readyTimeoutMs,
          (status) => ctx.setStatus(status),
        );
      });

      const tunnel = await timer.run('open MySQL SSH tunnel', () => openMysqlTunnel(state, ip));
      try {
        const mysqlConfig = makeMysqlConfig({
          host: '127.0.0.1',
          port: tunnel.localPort,
          user: 'importer',
          password: idp.importerPassword,
          database: 'dc',
        });

        const testPasswords = JSON.parse(
          idp.testPasswordsJson,
        ) as Record<string, string>;

        await timer.run('seed test database', (ctx) =>
          seedTestDb(mysqlConfig, {
            count: 0,
            extraUsers: TEST_USERS.map((user) => ({
              email: user.email,
              firstName: user.firstName,
              lastName: user.lastName,
                ...(user.password
                ? { password: testPasswords[user.email] }
                : {}),
              adminRole: user.adminRole,
              legacyRole: user.legacyRole,
              customer: user.customer,
              alsoCustomer: user.alsoCustomer,
              inactive: user.inactive,
              blocked: user.blocked,
              unverified: user.unverified,
              mustChange: user.mustChange,
            })),
          }),
        );

        await timer.run('import users into Keycloak', (ctx) =>
          importUsers(mysqlConfig, {
            baseUrl: idp.keycloakUrl,
            realm: 'digiclips',
            username: 'kcadmin',
            password: idp.bootstrapPassword,
          }),
        );

        await timer.run('credential assertions', async (ctx) => {
          const credentialResult = await execFile(
            'npx',
            ['vitest', 'run', 'test/test-credentials.test.ts'],
            {
              env: {
                ...process.env,
                MYSQL_HOST: '127.0.0.1',
                MYSQL_PORT: String(tunnel.localPort),
                MYSQL_USER: 'importer',
                MYSQL_PASSWORD: idp.importerPassword,
                MYSQL_DATABASE: 'dc',
                KEYCLOAK_URL: idp.keycloakUrl,
                IMPORT_TEST_PASSWORDS: idp.testPasswordsJson,
              },
              timeout: 300000,
              preview: ctx.preview,
            },
          );
          if (ctx.preview == null) {
            process.stdout.write(credentialResult.stdout);
            process.stderr.write(credentialResult.stderr);
          }
          if (credentialResult.status !== 0) {
            throw new Error('credential tests failed');
          }
        }, { previewLines: 12 });
      } finally {
        tunnel.process.kill();
      }
    }

    ui.log('[inttest] PASS');
  } catch (error) {
    failed = true;
    const message = error instanceof Error ? error.message : String(error);
    ui.error(`[inttest] FAILED: ${message}`);
    if (created) {
      try {
        ui.error('[inttest] collecting container journal...');
        const logs = await readContainerLogs(state.containerName);
        ui.error(logs);
      } catch (logError) {
        const logMessage = logError instanceof Error ? logError.message : String(logError);
        ui.error(`[inttest] diagnostics failed: ${logMessage}`);
      }
    }
    process.exitCode = 1;
  } finally {
    const shouldTeardown =
      output.teardownContainer === 'always' ||
      (output.teardownContainer === 'on-success' && !failed);
    if (created) {
      if (shouldTeardown) {
        try {
          await timer.run('destroy container', () => destroyContainer(state.containerName));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ui.error(`[inttest] destroy failed: ${message}`);
          process.exitCode = 1;
        }
      } else {
        ui.error(`[inttest] container retained at ${state.containerName}`);
      }
    }
    if (output.timing) {
      // Printed last so the breakdown is the final frame of a run, pass or fail.
      ui.log(timer.report());
    }
    if (shouldTeardown) {
      fs.rmSync(state.runDir, { recursive: true, force: true });
    } else {
      ui.error(`[inttest] run artifacts retained at ${state.runDir}`);
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(message);
  process.exit(1);
});
