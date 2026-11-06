# ansible-demo

Ansible deploys a minimal Node + Express app to a bare-metal Ubuntu 26.04 target. Integration tests run against a throwaway LXC container that provides a clean Ubuntu 26.04 instance.

## Requirements

- Ubuntu 26.04 (or WSL2 running Ubuntu 26.04). macOS and native Windows are not supported for integration tests.
- LXD initialized: `sudo lxd init --minimal` (usually once).
- Node.js and npm (installed via actions/setup-node in CI); Ansible (installed via Ubuntu packages in CI).
- Ansible is the control node, so it must run on Linux/WSL2 even on Windows.

## Install

```bash
sudo apt-get update
sudo apt-get install -y ansible ansible-lint yamllint
npm ci
npm run ensure:lxd
```

`npm run ensure:lxd` initializes/checks LXD. CI runs `lxd init --minimal` itself.

## Run

```bash
npm run check:ts
npm run inttest
npm run inttest:extended     # opt-in MySQL memo profile
npm run inttest:self         # deploy on the current host (Linux only)
```

## What the test does

1. Launch an Ubuntu 26.04 LXC container.
2. Wait for cloud-init, inject an ephemeral SSH key.
3. Provision via Ansible.
4. Run HTTP assertions against `GET /fib?n=10` (expects 55) and invalid input (expects 400).
5. Destroy the container and clean artifacts. On failure, diagnostics are retained in `.run/`.

## Config knobs

`roles/node_express_app/templates/app.env.j2` renders `PORT`, `APP_NAME`, `LOG_LEVEL`, `NODE_ENV`, optional `MYSQL_URL`.

## Notes

- `scripts/*.ts` use Node's native TypeScript support. No bundle/build step.
- LXC is **never** used in deployment roles; changing `app_backend` is the intended future pivot.
