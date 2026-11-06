import { execFileSync, execOrThrow } from './run.ts';
import { logger } from './logger.ts';

export interface LxdInstance {
  readonly name: string;
  readonly state?: {
    readonly network?: Record<string, { readonly addresses?: ReadonlyArray<{ readonly family: string; readonly address: string; readonly scope: string }> }>;
  };
}

export function ensureLxd(): void {
  const init = execFileSync('sudo', ['lxd', 'init', '--minimal'], { timeout: 60000 });
  if (init.status !== 0 && !init.stderr.includes('has already been initialized') && !init.stdout.includes('has already been initialized')) {
    logger.error(init.stderr);
  }
  const pools = execFileSync('lxc', ['storage', 'list', '--format', 'csv'], {});
  if (pools.status !== 0 || !pools.stdout.includes('default')) {
    throw new Error(`LXD storage is not initialized.\n${pools.stdout}\n${pools.stderr}`);
  }
  const networks = execFileSync('lxc', ['network', 'list', '--format', 'csv'], {});
  if (networks.status !== 0 || !networks.stdout.includes('lxdbr0')) {
    throw new Error(`LXD lxdbr0 network is not initialized.\n${networks.stdout}\n${networks.stderr}`);
  }
}

export function launchContainer(name: string): void {
  execOrThrow('lxc', ['launch', 'ubuntu:26.04', name], { timeout: 300000 });
}

export function waitForCloudInit(name: string): void {
  execOrThrow('lxc', ['exec', name, '--', 'cloud-init', 'status', '--wait'], { timeout: 300000 });
}

export function publishPublicKey(name: string, publicKey: string): void {
  const script = [
    'install -d -m 700 -o ubuntu -g ubuntu /home/ubuntu/.ssh',
    'cat > /home/ubuntu/.ssh/authorized_keys',
    'chown ubuntu:ubuntu /home/ubuntu/.ssh/authorized_keys',
    'chmod 600 /home/ubuntu/.ssh/authorized_keys',
  ].join('; ');
  const result = execFileSync('lxc', ['exec', name, '--', 'sh', '-c', script], {
    input: `${publicKey}\n`,
    timeout: 60000,
  });
  if (result.status !== 0) {
    throw new Error(`failed to publish public key: ${result.stderr}`);
  }
}

export function getContainerIpv4(name: string): string {
  const result = execFileSync('lxc', ['list', name, '--format', 'json'], {});
  if (result.status !== 0) {
    throw new Error(`lxc list failed: ${result.stderr}`);
  }
  const instances = JSON.parse(result.stdout) as LxdInstance[];
  const target = instances.find((instance) => instance.name === name);
  if (target == null) {
    throw new Error(`container ${name} not found in lxc list`);
  }
  const networks = target.state?.network ?? {};
  for (const networkName of Object.keys(networks)) {
    const addresses = networks[networkName]?.addresses ?? [];
    for (const addr of addresses) {
      if (addr.family === 'inet' && addr.scope === 'global' && !addr.address.startsWith('127.')) {
        return addr.address;
      }
    }
  }
  throw new Error(`no IPv4 address for container ${name}`);
}

export function waitForSsh(ip: string, privateKeyPath: string): void {
  const args = [
    '-i', privateKeyPath,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=5',
    `ubuntu@${ip}`,
    'true',
  ];
  const deadline = Date.now() + 120000;
  let lastStderr = '';
  while (Date.now() < deadline) {
    const res = execFileSync('ssh', args, { timeout: 20000 });
    if (res.status === 0) {
      return;
    }
    lastStderr = res.stderr;
    sleepMs(2000);
  }
  throw new Error(`SSH not ready for ${ip}: ${lastStderr}`);
}

export function readContainerLogs(name: string): string {
  const res = execFileSync('lxc', ['exec', name, '--', 'journalctl', '-u', 'node-express-app', '-n', '200', '--no-pager'], { timeout: 60000 });
  return `${res.stdout}\n${res.stderr}`;
}

export function destroyContainer(name: string): void {
  execFileSync('lxc', ['delete', name, '--force'], { timeout: 120000 });
}

function sleepMs(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Busy wait is acceptable for light, short readiness pauses.
  }
}
