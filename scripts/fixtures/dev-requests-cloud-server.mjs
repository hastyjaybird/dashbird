#!/usr/bin/env node
/**
 * Test double for the cloud dashboard's dev-requests API: the real router behind HTTP
 * basic auth, backed by DEV_REQUESTS_ROOT / DEV_REQUESTS_DB_PATH from the environment.
 * Used by scripts/smoke-dev-requests-pull.mjs; prints "listening <port>" once ready.
 */
import express from 'express';
import devRequestsRouter from '../../src/routes/dev-requests.js';

const USER = String(process.env.FAKE_CLOUD_USER || 'dashbird');
const PASS = String(process.env.FAKE_CLOUD_PASS || 'hunter2');

const app = express();

app.use((req, res, next) => {
  const header = String(req.headers.authorization || '');
  const expected = `Basic ${Buffer.from(`${USER}:${PASS}`, 'utf8').toString('base64')}`;
  if (header !== expected) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Dashbird", charset="UTF-8"');
    res.status(401).send('Unauthorized');
    return;
  }
  next();
});

app.use('/api/dev-requests', devRequestsRouter);

const server = app.listen(0, '127.0.0.1', () => {
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  console.log(`listening ${port}`);
});
