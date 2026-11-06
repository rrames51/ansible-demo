# AGENTS.md

Agent-specific guidance. Human-facing docs in README.md and docs/.

## Mission

LXC is the test-target simulator only. Ansible is the primary IaC layer. Deployment roles MUST NOT reference LXC. Built-in watch: scripts live in `scripts/*.ts` and run directly with `node`.

## Invariants

- No POSIX shell scripts for orchestration/test flow. Use TypeScript executed by Node.
- No LXC usage outside `scripts/lxd.ts` and inventory generation. Never add container semantics to roles.
- Node app binds 0.0.0.0.
- Systemd unit uses `EnvironmentFile`.
- Keep `app_backend` conditional and backend file split.
- Preserve `.run/<id>` on failure for diagnostics; clean on success.
- Generated host entry point must use the discovered container IP, never hard-code IPs.
- Scripts must remain erasable TypeScript: no enums, no parameter properties, `import type` where appropriate, no emit.

## Repo map

- `app/` Express source.
- `playbooks/site.yml`.
- `roles/`.
- `scripts/run.ts` subprocess helper.
- `scripts/lxd.ts` container lifecycle.
- `scripts/inttest.ts` one-click flow.
- `scripts/test-http.ts` HTTP assertions using `APP_URL`.
- `scripts/self.ts` target-host deploy (Linux only).
- `.run/` generated per test and gitignored.
- `inventories/lxc/` base vars (hosts.ini generated per run).

## Known constraints

- LXC native Linux/WSL2 only. macOS and Windows native not supported.
- Ansible control node requires Linux/WSL2.
- GitHub CI uses LXD via `lxd init --minimal`, which needs snap (runners have snapd).
- The Node runtime role installs `nodejs` and `npm` from Ubuntu packages; systemd uses `/usr/bin/node`.
- Busy-loop waits are used for simplicity in TypeScript; keep them short.
- LXD container image download can be the dominant cold-start cost.

## Typical agent workflows

- Change deploy logic, then run `npm run inttest` (real container).
- Change tests, then run against container; `APP_URL` could point at any host.
- Use `npm run check:ts` before a run.
