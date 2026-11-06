import { spawnSync } from 'node:child_process';

export interface ExecResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExecOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string | Uint8Array;
  readonly timeout?: number;
  readonly cwd?: string;
  readonly shell?: boolean;
}

export function execFileSync(
  cmd: string,
  args: readonly string[],
  options: ExecOptions = {}
): ExecResult {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: options.cwd,
    env: options.env ?? process.env,
    timeout: options.timeout,
    shell: options.shell ?? false,
    input: options.input,
  });
  const status = res.status == null ? 1 : res.status;
  let stderr = res.stderr == null ? '' : res.stderr;
  if (res.error) {
    stderr = `${stderr}\n${res.error.message}`.trim();
  }
  return {
    status,
    stdout: res.stdout == null ? '' : res.stdout,
    stderr,
  };
}

export function execOrThrow(
  cmd: string,
  args: readonly string[],
  options: ExecOptions = {}
): ExecResult {
  const res = execFileSync(cmd, args, options);
  if (res.status !== 0) {
    const output = [res.stdout, res.stderr].filter(Boolean).join('\n');
    throw new Error(
      `${cmd} ${args.join(' ')} exited with ${res.status}\n${output}`.trim()
    );
  }
  return res;
}
