'use strict';

/**
 * cwm-bench typical profile. RealWorld ("Conduit") shaped routes.
 * The lean app under app/ is a separate process and is not loaded here.
 *
 * Every workload request, including login, carries Authorization: Token <jwt>
 * and is verified before routing. /health and /api/meta stay unauthenticated
 * so the ALB and the worker adapter can call them.
 *
 * Error JSON keeps the lean contract:
 *   db_timeout | too_many_connections | queue_full | cpu_overload | internal
 */

const cluster = require('node:cluster');
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const { poolSizePerWorker, handleWorkerExit } = require('./pool');
const { signToken, verifyToken, TOKEN_EXP } = require('./token');

const PORT = Number(process.env.PORT || 8080);
const GIT_SHA = process.env.APP_GIT_SHA || 'unknown';
const MYSQL_HOST = process.env.MYSQL_HOST || '';
const MYSQL_PORT = Number(process.env.MYSQL_PORT || 3306);
const MYSQL_USER = process.env.MYSQL_USER || 'cwmbench';
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || '';
const MYSQL_DATABASE = process.env.MYSQL_DATABASE || 'cwmbench';

const ERROR_CLASSES = Object.freeze([
  'db_timeout',
  'too_many_connections',
  'queue_full',
  'cpu_overload',
  'internal',
]);

function readInteger(name, fallback, minimum) {
  const raw = process.env[name] == null || process.env[name] === '' ? String(fallback) : process.env[name];
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    process.stderr.write(`${name} must be an integer >= ${minimum}\n`);
    process.exit(1);
  }
  return value;
}

const APP_PROFILE = process.env.APP_PROFILE || 'typical';
const APP_WORKERS = readInteger('APP_WORKERS', 1, 1);
const APP_POOL_SIZE = readInteger('APP_POOL_SIZE', 250, 1);
const APP_QUEUE_LIMIT = readInteger('APP_QUEUE_LIMIT', 50, 0);
const POOL_PER_WORKER = poolSizePerWorker(APP_POOL_SIZE, APP_WORKERS);

if (APP_PROFILE !== 'typical') {
  process.stderr.write('app-typical requires APP_PROFILE=typical\n');
  process.exit(1);
}
if (APP_WORKERS > 8) {
  process.stderr.write('APP_WORKERS must be an integer from 1 to 8\n');
  process.exit(1);
}
if (POOL_PER_WORKER < 1) {
  process.stderr.write('per-worker connection limit is empty\n');
  process.exit(1);
}
if (!MYSQL_HOST) {
  process.stderr.write('MYSQL_HOST is required\n');
  process.exit(1);
}

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

function wrapMysqlError(err) {
  if (err && err.errorClass) return err;
  const classified = classifyMysqlError(err);
  const wrapped = new Error(err && err.message ? err.message : 'mysql error');
  wrapped.status = classified.status;
  wrapped.errorClass = classified.class;
  return wrapped;
}

function isoUtc(value) {
  const text = String(value == null ? '' : value).trim().replace(' ', 'T');
  if (!text) return null;
  return text.endsWith('Z') ? text : `${text}Z`;
}

function asNumber(value) {
  if (typeof value === 'bigint') return Number(value);
  return Number(value);
}

function asBool(value) {
  return Number(value) === 1;
}

function authorJson(row) {
  return {
    username: row.username,
    bio: row.bio,
    image: row.image,
    following: asBool(row.following),
  };
}

function articleCore(row, tagList) {
  return {
    slug: row.slug,
    title: row.title,
    description: row.description,
    tagList,
    createdAt: isoUtc(row.created_at),
    updatedAt: isoUtc(row.updated_at),
    favorited: false,
    favoritesCount: asNumber(row.favorites_count),
    author: authorJson(row),
  };
}

function placeholders(values) {
  return values.map(() => '?').join(', ');
}

let pool = null;

async function query(sql, params) {
  try {
    const [rows] = await pool.execute(sql, params);
    return rows;
  } catch (err) {
    throw wrapMysqlError(err);
  }
}

async function execOn(conn, sql, params) {
  try {
    const [rows] = await conn.execute(sql, params);
    return rows;
  } catch (err) {
    throw wrapMysqlError(err);
  }
}

function requiresToken(req) {
  return req.path.startsWith('/api/articles') ||
    req.path.startsWith('/api/profiles') ||
    req.path.startsWith('/api/users');
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/meta', (_req, res) => {
  res.json({
    service: 'cwm-bench-app',
    profile: 'typical',
    workers: APP_WORKERS,
    poolSize: APP_POOL_SIZE,
    poolSizePerWorker: POOL_PER_WORKER,
    queueLimit: APP_QUEUE_LIMIT,
    gitSha: GIT_SHA,
    node: process.version,
  });
});

app.use((req, res, next) => {
  if (!requiresToken(req)) return next();
  const header = req.get('authorization') || '';
  const match = /^Token (\S+)$/.exec(header);
  if (!match) return sendError(res, 401, 'internal', 'invalid token');
  try {
    req.auth = verifyToken(match[1]);
    return next();
  } catch (_err) {
    return sendError(res, 401, 'internal', 'invalid token');
  }
});

app.get('/api/articles', async (req, res, next) => {
  try {
    const limit = Number(req.query.limit);
    const offset = Number(req.query.offset);
    if (limit !== 20 || !Number.isInteger(offset) || offset < 0 || offset > 980 || offset % 20 !== 0) {
      return sendError(res, 400, 'internal', 'invalid articles page');
    }
    const articles = await query(
      `SELECT a.id, a.slug, a.title, a.description, a.created_at, a.updated_at, a.favorites_count,
              u.username, u.bio, u.image, u.id AS author_id
         FROM articles a
         JOIN users u ON u.id = a.author_id
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT 20 OFFSET ${offset}`,
      []
    );
    const ids = articles.map((row) => row.id);
    const authorIds = [...new Set(articles.map((row) => row.author_id))];
    let tagRows = [];
    let followRows = [];
    if (ids.length > 0) {
      tagRows = await query(
        `SELECT at.article_id, t.name
           FROM article_tags at
           JOIN tags t ON t.id = at.tag_id
          WHERE at.article_id IN (${placeholders(ids)})
          ORDER BY at.article_id, t.name`,
        ids
      );
    }
    if (authorIds.length > 0) {
      followRows = await query(
        `SELECT followee_id
           FROM follows
          WHERE follower_id = ? AND followee_id IN (${placeholders(authorIds)})`,
        [req.auth.sub, ...authorIds]
      );
    }
    const tagsByArticle = new Map();
    for (const row of tagRows) {
      const list = tagsByArticle.get(row.article_id) || [];
      list.push(row.name);
      tagsByArticle.set(row.article_id, list);
    }
    const followed = new Set(followRows.map((row) => row.followee_id));
    const items = articles.map((row) => articleCore(
      { ...row, following: followed.has(row.author_id) ? 1 : 0 },
      tagsByArticle.get(row.id) || []
    ));
    return res.json({ articles: items });
  } catch (err) {
    return next(err);
  }
});

app.get('/api/articles/:slug', async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT a.id, a.slug, a.title, a.description, a.body, a.created_at, a.updated_at,
              a.favorites_count, u.username, u.bio, u.image,
              CASE WHEN f.followee_id IS NULL THEN 0 ELSE 1 END AS following
         FROM articles a
         JOIN users u ON u.id = a.author_id
         LEFT JOIN follows f ON f.follower_id = ? AND f.followee_id = u.id
        WHERE a.slug = ?`,
      [req.auth.sub, req.params.slug]
    );
    if (rows.length === 0) return sendError(res, 404, 'internal', 'article not found');
    const article = rows[0];
    const tagRows = await query(
      `SELECT t.name
         FROM article_tags at
         JOIN tags t ON t.id = at.tag_id
        WHERE at.article_id = ?
        ORDER BY t.name`,
      [article.id]
    );
    const comments = await query(
      `SELECT c.id, c.body, c.created_at, u.username, u.bio, u.image,
              CASE WHEN f.followee_id IS NULL THEN 0 ELSE 1 END AS following
         FROM comments c
         JOIN users u ON u.id = c.author_id
         LEFT JOIN follows f ON f.follower_id = ? AND f.followee_id = u.id
        WHERE c.article_id = ?
        ORDER BY c.id ASC
        LIMIT 5`,
      [req.auth.sub, article.id]
    );
    return res.json({
      article: {
        ...articleCore(article, tagRows.map((row) => row.name)),
        body: article.body,
        comments: comments.map((row) => ({
          id: asNumber(row.id),
          body: row.body,
          createdAt: isoUtc(row.created_at),
          author: authorJson(row),
        })),
      },
    });
  } catch (err) {
    return next(err);
  }
});

app.get('/api/profiles/:username', async (req, res, next) => {
  try {
    const users = await query(
      'SELECT id, username, bio, image FROM users WHERE username = ?',
      [req.params.username]
    );
    if (users.length === 0) return sendError(res, 404, 'internal', 'profile not found');
    const user = users[0];
    const follows = await query(
      'SELECT 1 AS following FROM follows WHERE follower_id = ? AND followee_id = ? LIMIT 1',
      [req.auth.sub, user.id]
    );
    return res.json({
      profile: {
        username: user.username,
        bio: user.bio,
        image: user.image,
        following: follows.length > 0,
      },
    });
  } catch (err) {
    return next(err);
  }
});

app.post('/api/articles/:slug/comments', async (req, res, next) => {
  const comment = req.body && req.body.comment;
  const body = comment && comment.body;
  if (typeof body !== 'string' || body.length < 1 || body.length > 1000) {
    return sendError(res, 400, 'internal', 'invalid comment');
  }
  const createdAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const found = await execOn(
      conn,
      `SELECT a.id AS article_id, u.username, u.bio, u.image,
              EXISTS(
                SELECT 1 FROM follows f
                 WHERE f.follower_id = ? AND f.followee_id = u.id
              ) AS following
         FROM articles a
         LEFT JOIN users u ON u.id = ?
        WHERE a.slug = ?`,
      [req.auth.sub, req.auth.sub, req.params.slug]
    );
    if (found.length === 0) {
      await conn.rollback();
      return sendError(res, 404, 'internal', 'article not found');
    }
    const author = found[0];
    if (!author.username) {
      await conn.rollback();
      return sendError(res, 401, 'internal', 'invalid token');
    }
    const inserted = await execOn(
      conn,
      'INSERT INTO comments (article_id, author_id, body, created_at) VALUES (?, ?, ?, ?)',
      [author.article_id, req.auth.sub, body, createdAt]
    );
    await conn.commit();
    return res.status(201).json({
      comment: {
        id: asNumber(inserted.insertId),
        body,
        createdAt: isoUtc(createdAt),
        author: authorJson(author),
      },
    });
  } catch (err) {
    if (conn) {
      try {
        await conn.rollback();
      } catch (_rollbackErr) {
        // The original error is the one to classify.
      }
    }
    return next(err);
  } finally {
    if (conn) conn.release();
  }
});

app.post('/api/users/login', async (req, res, next) => {
  try {
    const userBody = req.body && req.body.user;
    const email = userBody && userBody.email;
    const password = userBody && userBody.password;
    if (typeof email !== 'string' || email.length < 1 || typeof password !== 'string' || password.length < 1) {
      return sendError(res, 400, 'internal', 'invalid login');
    }
    const users = await query(
      'SELECT id, email, username, bio, image, password_hash FROM users WHERE email = ?',
      [email]
    );
    if (users.length === 0) return sendError(res, 401, 'internal', 'invalid login');
    const user = users[0];
    const matches = await bcrypt.compare(password, user.password_hash);
    if (!matches) return sendError(res, 401, 'internal', 'invalid login');
    const iat = Math.floor(Date.now() / 1000);
    const token = signToken({
      sub: user.id,
      username: user.username,
      iat,
      exp: TOKEN_EXP,
    });
    return res.json({
      user: {
        email: user.email,
        token,
        username: user.username,
        bio: user.bio,
        image: user.image,
      },
    });
  } catch (err) {
    return next(err);
  }
});

app.use((err, _req, res, _next) => {
  const errorClass = err.errorClass || 'internal';
  const status = err.status || 500;
  return sendError(res, status, errorClass, err.message || 'internal error');
});

function startPrimary() {
  const state = { shuttingDown: false, restarts: 0 };
  const shutdown = () => {
    state.shuttingDown = true;
    for (const worker of Object.values(cluster.workers || {})) {
      worker.kill('SIGTERM');
    }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  cluster.on('exit', () => {
    const before = state.restarts;
    const restarts = handleWorkerExit(state, () => cluster.fork());
    if (restarts === before) return;
    process.stdout.write(`${JSON.stringify({ msg: 'worker respawned', restarts })}\n`);
  });
  for (let i = 0; i < APP_WORKERS; i += 1) cluster.fork();
  process.stdout.write(`${JSON.stringify({
    msg: 'cwm-bench-typical primary',
    profile: 'typical',
    workers: APP_WORKERS,
    poolSize: APP_POOL_SIZE,
    poolSizePerWorker: POOL_PER_WORKER,
  })}\n`);
}

async function startWorker() {
  pool = mysql.createPool({
    host: MYSQL_HOST,
    port: MYSQL_PORT,
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    database: MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: POOL_PER_WORKER,
    queueLimit: APP_QUEUE_LIMIT,
    connectTimeout: 5000,
    enableKeepAlive: true,
    dateStrings: true,
    timezone: 'Z',
  });
  app.listen(PORT, '0.0.0.0', () => {
    process.stdout.write(`${JSON.stringify({
      msg: 'cwm-bench-typical listening',
      profile: 'typical',
      port: PORT,
      workers: APP_WORKERS,
      poolSize: APP_POOL_SIZE,
      poolSizePerWorker: POOL_PER_WORKER,
      queueLimit: APP_QUEUE_LIMIT,
      gitSha: GIT_SHA,
      node: process.version,
      workerId: cluster.worker && cluster.worker.id,
    })}\n`);
  });
}

if (cluster.isPrimary) {
  startPrimary();
} else {
  startWorker().catch((err) => {
    process.stderr.write(`${String(err && err.stack ? err.stack : err)}\n`);
    process.exit(1);
  });
}
