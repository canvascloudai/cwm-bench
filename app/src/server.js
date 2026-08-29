'use strict';

/**
 * cwm-bench reference app — workload definition, not a TPC clone.
 *
 * Request mix consumed by load/scripts: 70% GET /api/products/:id,
 * 20% GET /api/products, 10% POST /api/orders.
 *
 * Every error response includes a machine-readable class:
 *   db_timeout | too_many_connections | queue_full | cpu_overload | internal
 *
 * iops_throttle is NOT an application class. gp2 BurstBalance=0 is a
 * CloudWatch-derived third bucket (see schema/ and holdout/REPORT.md).
 * Do not fold IOPS throttle into CPU or DB connection failures.
 */

const express = require('express');
const mysql = require('mysql2/promise');

const PORT = Number(process.env.PORT || 8080);
const APP_POOL_SIZE = Number(process.env.APP_POOL_SIZE || 250);
const APP_QUEUE_LIMIT = Number(process.env.APP_QUEUE_LIMIT || 50);
const CPU_SPIN_MAX_MS = Number(process.env.CPU_SPIN_MAX_MS || 2000);
const CPU_SPIN_MAX_CONCURRENT = Number(process.env.CPU_SPIN_MAX_CONCURRENT || 4);
const MYSQL_HOST = process.env.MYSQL_HOST || '';
const MYSQL_PORT = Number(process.env.MYSQL_PORT || 3306);
const MYSQL_USER = process.env.MYSQL_USER || 'cwmbench';
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || '';
const MYSQL_DATABASE = process.env.MYSQL_DATABASE || 'cwmbench';
const GIT_SHA = process.env.APP_GIT_SHA || 'unknown';

const ERROR_CLASSES = Object.freeze([
  'db_timeout',
  'too_many_connections',
  'queue_full',
  'cpu_overload',
  'internal',
]);

function errorBody(errorClass, message) {
  return { error: { class: errorClass, message: message || errorClass } };
}

function sendError(res, status, errorClass, message) {
  if (!ERROR_CLASSES.includes(errorClass)) {
    errorClass = 'internal';
  }
  return res.status(status).json(errorBody(errorClass, message));
}

function classifyMysqlError(err) {
  const code = err && (err.code || err.errno);
  const msg = String((err && err.message) || '');
  if (code === 'ER_CON_COUNT_ERROR' || code === 1040 || /too many connections/i.test(msg)) {
    return { status: 503, class: 'too_many_connections' };
  }
  if (code === 'POOL_ENQUEUELIMIT' || /queue limit reached/i.test(msg)) {
    return { status: 503, class: 'queue_full' };
  }
  if (
    code === 'ETIMEDOUT' ||
    code === 'PROTOCOL_SEQUENCE_TIMEOUT' ||
    code === 'PROTOCOL_CONNECTION_LOST' ||
    code === 'ECONNRESET' ||
    /timeout/i.test(msg)
  ) {
    return { status: 504, class: 'db_timeout' };
  }
  return { status: 500, class: 'internal' };
}

let pool = null;
let cpuSpinInFlight = 0;

async function query(sql, params) {
  try {
    const [rows] = await pool.execute(sql, params);
    return rows;
  } catch (err) {
    const classified = classifyMysqlError(err);
    const wrapped = new Error(err.message);
    wrapped.status = classified.status;
    wrapped.errorClass = classified.class;
    throw wrapped;
  }
}

function busyWaitCooperative(ms) {
  return new Promise((resolve) => {
    const end = Date.now() + ms;
    let checksum = 0;
    function slice() {
      const sliceEnd = Math.min(Date.now() + 8, end);
      while (Date.now() < sliceEnd) {
        checksum += Math.sqrt(checksum + 1);
      }
      if (Date.now() < end) {
        setImmediate(slice);
      } else {
        resolve(checksum);
      }
    }
    slice();
  });
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

// ALB health is process liveness only. A DB-backed check would deregister
// targets during connection saturation and hide the failure mode we measure.
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/meta', (_req, res) => {
  res.json({
    service: 'cwm-bench-app',
    node: process.version,
    poolSize: APP_POOL_SIZE,
    queueLimit: APP_QUEUE_LIMIT,
    gitSha: GIT_SHA,
  });
});

app.get('/api/products/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return sendError(res, 400, 'internal', 'invalid product id');
    }
    const rows = await query(
      'SELECT id, sku, name, price_cents, category_id FROM products WHERE id = ?',
      [id]
    );
    if (rows.length === 0) {
      return sendError(res, 404, 'internal', 'product not found');
    }
    return res.json(rows[0]);
  } catch (err) {
    return next(err);
  }
});

app.get('/api/products', async (_req, res, next) => {
  try {
    const rows = await query(
      'SELECT id, sku, name, price_cents, category_id FROM products ORDER BY id ASC LIMIT 50'
    );
    return res.json({ items: rows, count: rows.length });
  } catch (err) {
    return next(err);
  }
});

app.post('/api/orders', async (req, res, next) => {
  try {
    const productId = Number(req.body && req.body.productId);
    const qty = Number((req.body && req.body.qty) || 1);
    if (
      !Number.isInteger(productId) ||
      productId < 1 ||
      !Number.isInteger(qty) ||
      qty < 1 ||
      qty > 100
    ) {
      return sendError(res, 400, 'internal', 'invalid order payload');
    }
    const products = await query('SELECT id FROM products WHERE id = ?', [productId]);
    if (products.length === 0) {
      return sendError(res, 404, 'internal', 'product not found');
    }
    const result = await query('INSERT INTO orders (product_id, qty) VALUES (?, ?)', [
      productId,
      qty,
    ]);
    return res.status(201).json({ id: result.insertId, productId, qty });
  } catch (err) {
    return next(err);
  }
});

app.get('/api/cpu-spin', async (req, res) => {
  const ms = Number(req.query.ms);
  if (!Number.isFinite(ms) || ms < 1 || ms > CPU_SPIN_MAX_MS) {
    return sendError(res, 400, 'internal', `ms must be 1..${CPU_SPIN_MAX_MS}`);
  }
  if (cpuSpinInFlight >= CPU_SPIN_MAX_CONCURRENT) {
    return sendError(res, 503, 'cpu_overload', 'cpu-spin concurrency limit reached');
  }
  cpuSpinInFlight += 1;
  try {
    const checksum = await busyWaitCooperative(ms);
    return res.json({ spunMs: ms, checksum });
  } finally {
    cpuSpinInFlight -= 1;
  }
});

app.use((err, _req, res, _next) => {
  const errorClass = err.errorClass || 'internal';
  const status = err.status || 500;
  return sendError(res, status, errorClass, err.message || 'internal error');
});

async function main() {
  if (!MYSQL_HOST) {
    process.stderr.write('MYSQL_HOST is required\n');
    process.exit(1);
  }
  pool = mysql.createPool({
    host: MYSQL_HOST,
    port: MYSQL_PORT,
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    database: MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: APP_POOL_SIZE,
    queueLimit: APP_QUEUE_LIMIT,
    connectTimeout: 5000,
    enableKeepAlive: true,
  });
  app.listen(PORT, '0.0.0.0', () => {
    process.stdout.write(
      JSON.stringify({
        msg: 'cwm-bench-app listening',
        port: PORT,
        poolSize: APP_POOL_SIZE,
        gitSha: GIT_SHA,
        node: process.version,
      }) + '\n'
    );
  });
}

main().catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
  process.exit(1);
});
