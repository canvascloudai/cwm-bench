/**
 * Correctness-only check of app-typical against MySQL 8.0.
 * Row counts, a second seed, response shapes, bcrypt login, and token rejection.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { tokenForUser, verifyToken } = require('../../app-typical/src/token.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONTAINER = 'cwm-typical-mysql';
const MYSQL_PORT = 33066;
const APP_PORT = 18080;
const ROOT_PASSWORD = 'cwmbench-root';
const APP_PASSWORD = 'cwmbench';
const LOGIN_PASSWORD = 'cwm-bench-password';

const EXPECTED_COUNTS = {
  users: 1000,
  tags: 50,
  articles: 10000,
  article_tags: 30000,
  comments: 50000,
  follows: 10000,
};

function fail(message) {
  throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) fail(`${label}: expected ${expected} but got ${actual}`);
}

let dockerCmd = null;

function resolveDocker() {
  if (dockerCmd) return dockerCmd;
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    dockerCmd = ['docker'];
  } catch {
    execFileSync('sudo', ['docker', 'info'], { stdio: 'ignore' });
    dockerCmd = ['sudo', 'docker'];
  }
  return dockerCmd;
}

function docker(args, options = {}) {
  const [bin, ...prefix] = resolveDocker();
  try {
    return execFileSync(bin, [...prefix, ...args], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      ...options,
    });
  } catch (err) {
    const stderr = err.stderr ? String(err.stderr) : '';
    const stdout = err.stdout ? String(err.stdout) : '';
    fail(`docker ${args.join(' ')} failed\n${stderr}\n${stdout}`);
  }
  return '';
}

function mysql(sql) {
  return docker(
    ['exec', '-e', `MYSQL_PWD=${ROOT_PASSWORD}`, '-i', CONTAINER, 'mysql', '-uroot', '--batch', '--raw', '--skip-column-names'],
    { input: sql }
  );
}

function nodeBinary() {
  const candidate = '/usr/local/bin/node';
  if (existsSync(candidate)) {
    const version = execFileSync(candidate, ['--version'], { encoding: 'utf8' }).trim();
    if (version.startsWith('v20.')) return candidate;
  }
  return process.execPath;
}

async function waitForMysql() {
  // ping can succeed on the entrypoint's temporary server before the root
  // password exists. Wait until that password can run a query.
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      docker(
        ['exec', '-e', `MYSQL_PWD=${ROOT_PASSWORD}`, CONTAINER, 'mysql', '-uroot', '-N', '-e', 'SELECT 1'],
        { stdio: 'ignore' }
      );
      return;
    } catch {
      await delay(2000);
    }
  }
  fail('MySQL 8.0 did not accept connections');
}

function checksums() {
  const text = mysql(
    'CHECKSUM TABLE cwmbench.users, cwmbench.tags, cwmbench.articles, cwmbench.article_tags, cwmbench.comments, cwmbench.follows;'
  );
  const rows = {};
  for (const line of text.trim().split('\n')) {
    if (!line || line.startsWith('Table')) continue;
    const [table, checksum] = line.split('\t');
    rows[table] = checksum;
  }
  return rows;
}

function counts() {
  const text = mysql(`
    SELECT 'users', COUNT(*) FROM cwmbench.users
    UNION ALL SELECT 'tags', COUNT(*) FROM cwmbench.tags
    UNION ALL SELECT 'articles', COUNT(*) FROM cwmbench.articles
    UNION ALL SELECT 'article_tags', COUNT(*) FROM cwmbench.article_tags
    UNION ALL SELECT 'comments', COUNT(*) FROM cwmbench.comments
    UNION ALL SELECT 'follows', COUNT(*) FROM cwmbench.follows;
  `);
  const rows = {};
  for (const line of text.trim().split('\n')) {
    const [name, count] = line.split('\t');
    rows[name] = Number(count);
  }
  return rows;
}

async function api(pathname, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Token ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`http://127.0.0.1:${APP_PORT}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

function sortedCopy(values) {
  return [...values].sort();
}

async function main() {
  docker(['rm', '-f', CONTAINER], { stdio: 'ignore' });
  docker([
    'run', '-d', '--name', CONTAINER,
    '-e', `MYSQL_ROOT_PASSWORD=${ROOT_PASSWORD}`,
    '-p', `127.0.0.1:${MYSQL_PORT}:3306`,
    'mysql:8.0',
  ]);
  await waitForMysql();

  const seedPath = path.join(ROOT, 'app-typical/seed/seed-typical.sql');
  const seedSql = readFileSync(seedPath);
  mysql(seedSql);
  const first = checksums();
  mysql(seedSql);
  const second = checksums();
  const names = Object.keys(EXPECTED_COUNTS);
  for (const name of names) {
    const key = `cwmbench.${name}`;
    if (!first[key] || first[key] === 'NULL') fail(`checksum missing for ${key}: ${JSON.stringify(first)}`);
    assertEqual(second[key], first[key], `checksum ${name}`);
  }
  const observed = counts();
  for (const [name, expected] of Object.entries(EXPECTED_COUNTS)) {
    assertEqual(observed[name], expected, `rows ${name}`);
  }
  const selfFollows = Number(mysql('SELECT COUNT(*) FROM cwmbench.follows WHERE follower_id = followee_id;').trim());
  assertEqual(selfFollows, 0, 'self follows');
  console.log('seed row counts and checksums match');

  mysql(`
    CREATE USER IF NOT EXISTS 'cwmbench'@'%' IDENTIFIED BY '${APP_PASSWORD}';
    GRANT ALL PRIVILEGES ON cwmbench.* TO 'cwmbench'@'%';
    FLUSH PRIVILEGES;
  `);

  const logs = [];
  const child = spawn(nodeBinary(), ['src/server.js'], {
    cwd: path.join(ROOT, 'app-typical'),
    detached: true,
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      APP_PROFILE: 'typical',
      APP_WORKERS: '2',
      APP_POOL_SIZE: '250',
      APP_QUEUE_LIMIT: '50',
      APP_GIT_SHA: 'correctness',
      MYSQL_HOST: '127.0.0.1',
      MYSQL_PORT: String(MYSQL_PORT),
      MYSQL_USER: 'cwmbench',
      MYSQL_PASSWORD: APP_PASSWORD,
      MYSQL_DATABASE: 'cwmbench',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));

  try {
    let healthy = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const health = await api('/health');
        if (health.status === 200 && health.json && health.json.status === 'ok') {
          healthy = true;
          break;
        }
      } catch {
        // Workers are still binding the port.
      }
      await delay(250);
    }
    if (!healthy) fail(`app did not become healthy\n${logs.join('').slice(-4000)}`);

    const meta = await api('/api/meta');
    assertEqual(meta.status, 200, 'meta status');
    assertEqual(meta.json.service, 'cwm-bench-app', 'meta service');
    assertEqual(meta.json.profile, 'typical', 'meta profile');
    assertEqual(meta.json.workers, 2, 'meta workers');
    assertEqual(meta.json.poolSize, 250, 'meta poolSize');
    assertEqual(meta.json.poolSizePerWorker, 125, 'meta poolSizePerWorker');
    assertEqual(meta.json.queueLimit, 50, 'meta queueLimit');
    assertEqual(meta.json.gitSha, 'correctness', 'meta gitSha');
    assertEqual(typeof meta.json.node, 'string', 'meta node');

    const token = tokenForUser(1);
    const missing = await api('/api/articles?limit=20&offset=0');
    assertEqual(missing.status, 401, 'missing token status');
    assertEqual(missing.json.error.class, 'internal', 'missing token class');
    const bad = await api('/api/users/login', {
      method: 'POST',
      token: `${token}x`,
      body: { user: { email: 'user1@example.test', password: LOGIN_PASSWORD } },
    });
    assertEqual(bad.status, 401, 'bad token status');
    assertEqual(bad.json.error.class, 'internal', 'bad token class');

    const page = await api('/api/articles?limit=20&offset=0', { token });
    assertEqual(page.status, 200, 'articles status');
    assertEqual(page.json.articles.length, 20, 'articles length');
    const firstArticle = page.json.articles[0];
    assertEqual(firstArticle.slug, 'article-10000', 'first slug');
    assertEqual(firstArticle.title.length, 60, 'title length');
    assertEqual(firstArticle.description.length, 200, 'description length');
    assertEqual(firstArticle.favorited, false, 'favorited');
    assertEqual(firstArticle.favoritesCount, 0, 'favoritesCount');
    assertEqual(JSON.stringify(firstArticle.tagList), JSON.stringify(sortedCopy(firstArticle.tagList)), 'tag order');
    assertEqual(JSON.stringify(firstArticle.tagList), JSON.stringify(['tag01', 'tag18', 'tag32']), 'tag list');
    assertEqual(firstArticle.author.username, 'user1000', 'list author');
    assertEqual(typeof firstArticle.author.following, 'boolean', 'list following');
    assertEqual(typeof firstArticle.createdAt, 'string', 'createdAt');
    assertEqual(firstArticle.createdAt.endsWith('Z'), true, 'createdAt utc');
    const lastPage = await api('/api/articles?limit=20&offset=980', { token });
    assertEqual(lastPage.json.articles[0].slug, 'article-9020', 'offset slug');
    assertEqual(lastPage.json.articles[0].slug === firstArticle.slug, false, 'pages differ');

    const detail = await api('/api/articles/article-1', { token });
    assertEqual(detail.status, 200, 'detail status');
    assertEqual(detail.json.article.body.length, 1000, 'body length');
    assertEqual(detail.json.article.comments.length, 5, 'comment count');
    assertEqual(
      JSON.stringify(detail.json.article.comments.map((comment) => comment.id)),
      JSON.stringify([1, 10001, 20001, 30001, 40001]),
      'oldest comments'
    );
    for (const comment of detail.json.article.comments) {
      assertEqual(comment.body.length, 200, 'seed comment length');
      assertEqual(typeof comment.author.username, 'string', 'comment author');
    }

    const followed = await api('/api/profiles/user38', { token });
    assertEqual(followed.status, 200, 'followed profile status');
    assertEqual(followed.json.profile.username, 'user38', 'followed username');
    assertEqual(followed.json.profile.bio.length, 100, 'bio length');
    assertEqual(followed.json.profile.following, true, 'following true');
    assertEqual(typeof followed.json.profile.image, 'string', 'image');
    const unfollowed = await api('/api/profiles/user2', { token });
    assertEqual(unfollowed.json.profile.following, false, 'following false');

    const created = await api('/api/articles/article-1/comments', {
      method: 'POST',
      token,
      body: { comment: { body: 'c'.repeat(200) } },
    });
    assertEqual(created.status, 201, 'create comment status');
    assertEqual(created.json.comment.body.length, 200, 'created body');
    assertEqual(created.json.comment.author.username, 'user1', 'created author');
    assertEqual(typeof created.json.comment.id, 'number', 'created id');
    const commentCount = Number(mysql('SELECT COUNT(*) FROM cwmbench.comments;').trim());
    assertEqual(commentCount, 50001, 'comments after insert');
    const invalid = await api('/api/articles/article-1/comments', {
      method: 'POST',
      token,
      body: { comment: { body: '' } },
    });
    assertEqual(invalid.status, 400, 'invalid comment status');
    assertEqual(invalid.json.error.class, 'internal', 'invalid comment class');

    const login = await api('/api/users/login', {
      method: 'POST',
      token,
      body: { user: { email: 'user1@example.test', password: LOGIN_PASSWORD } },
    });
    assertEqual(login.status, 200, 'login status');
    assertEqual(login.json.user.email, 'user1@example.test', 'login email');
    assertEqual(login.json.user.username, 'user1', 'login username');
    assertEqual(login.json.user.bio.length, 100, 'login bio');
    const signed = verifyToken(login.json.user.token);
    assertEqual(signed.username, 'user1', 'login token user');
    const rejected = await api('/api/users/login', {
      method: 'POST',
      token,
      body: { user: { email: 'user1@example.test', password: 'wrong-password' } },
    });
    assertEqual(rejected.status, 401, 'wrong password status');
    assertEqual(rejected.json.error.class, 'internal', 'wrong password class');
    console.log('endpoints, login, and token rejection match');
  } finally {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    docker(['rm', '-f', CONTAINER], { stdio: 'ignore' });
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  try {
    docker(['rm', '-f', CONTAINER], { stdio: 'ignore' });
  } catch {
    // The container may already be gone.
  }
  process.exit(1);
});
