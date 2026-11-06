'use strict';

const express = require('express');

const PORT = Number(process.env.PORT) || 3000;
const APP_NAME = process.env.APP_NAME || 'node-express-app';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

function fib(n) {
  if (n < 2) return n;
  let a = 0;
  let b = 1;
  for (let i = 2; i <= n; i++) {
    const t = a + b;
    a = b;
    b = t;
  }
  return b;
}

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', app: APP_NAME, logLevel: LOG_LEVEL });
});

app.get('/fib', (req, res) => {
  const n = Number(req.query.n);
  if (!Number.isInteger(n) || n < 0 || n > 50) {
    return res.status(400).json({ error: 'invalid n (integer 0..50)' });
  }
  res.json({ n, result: fib(n) });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`${APP_NAME} listening on ${PORT}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
