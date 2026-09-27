/**
 * Typical profile mix. Total shares are 59 / 20 / 10 / 10 / 1.
 *
 *   59% GET /api/articles?limit=20&offset=O   O = 20 * U, U uniform in 0..49
 *   20% GET /api/articles/:slug               slug uniform over 10,000 articles
 *   10% GET /api/profiles/:username           username uniform over 1,000 users
 *   10% POST /api/articles/:slug/comments     fixed 200-character body
 *    1% POST /api/users/login                 bcrypt password, still sends a token
 *
 * Every request sends Authorization: Token <jwt>. Tokens are HS256, one per
 * seeded user, with a fixed iat and exp. The signing key is a public
 * benchmark constant shared with app-typical/src/token.js.
 *
 * Protocol matches the lean rungs: warmup, then steady. This script records
 * error classes and writes summary.json. It does not score a run.
 */

import http from 'k6/http';
import { check } from 'k6';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';
import {
  TYPICAL_RPS,
  DEFAULT_WARMUP,
  DEFAULT_DURATION,
  arrivalScenarios,
  envOr,
  requireTarget,
  recordErrorClass,
  handleRunSummary,
  SUMMARY_TREND_STATS,
} from './lib/common.js';

const TOKEN_KEY = 'cwm-bench-typical-hs256-key';
const TOKEN_HEADER_JSON = '{"alg":"HS256","typ":"JWT"}';
const TOKEN_IAT = 1767225600;
const TOKEN_EXP = 4102444800;
const USER_COUNT = 1000;
const ARTICLE_COUNT = 10000;
const COMMENT_BODY = 'c'.repeat(200);
const PASSWORD = 'cwm-bench-password';

const scenarioName = envOr('SCENARIO', 'typical-fit-20');
if (!Object.prototype.hasOwnProperty.call(TYPICAL_RPS, scenarioName)) {
  throw new Error(`SCENARIO must be one of ${Object.keys(TYPICAL_RPS).join(', ')}`);
}

const rps = TYPICAL_RPS[scenarioName];
const warmup = envOr('WARMUP', DEFAULT_WARMUP);
const duration = envOr('DURATION', DEFAULT_DURATION);
const target = requireTarget();

function b64url(text) {
  return encoding.b64encode(text, 'rawurl');
}

function tokenForUser(userId) {
  const header = b64url(TOKEN_HEADER_JSON);
  const payload = b64url(
    `{"sub":"${userId}","username":"user${userId}","iat":${TOKEN_IAT},"exp":${TOKEN_EXP}}`
  );
  const data = `${header}.${payload}`;
  const signature = crypto.hmac('sha256', TOKEN_KEY, data, 'base64rawurl');
  return `${data}.${signature}`;
}

const tokens = new Array(USER_COUNT + 1);
for (let userId = 1; userId <= USER_COUNT; userId += 1) {
  tokens[userId] = tokenForUser(userId);
}

if (__ENV.CWM_TOKEN_SELFTEST === '1') {
  const expected = __ENV.CWM_EXPECTED_TOKEN || '';
  if (tokens[1] !== expected) {
    throw new Error('load token does not match the app token for user 1');
  }
}

export const options = {
  discardResponseBodies: false,
  summaryTrendStats: SUMMARY_TREND_STATS,
  scenarios: arrivalScenarios(rps, warmup, duration),
  tags: {
    campaign_id: envOr('CAMPAIGN_ID', 'unset-campaign'),
    run_id: envOr('RUN_ID', 'unset-run'),
    split: envOr('SPLIT', 'unspecified'),
    diagnostic: 'typical',
    scenario: scenarioName,
  },
};

function userId() {
  return 1 + Math.floor(Math.random() * USER_COUNT);
}

function articleNumber() {
  return 1 + Math.floor(Math.random() * ARTICLE_COUNT);
}

function requestParams(name, id, jsonBody) {
  const headers = { Authorization: `Token ${tokens[id]}` };
  if (jsonBody) headers['Content-Type'] = 'application/json';
  return { headers, tags: { name } };
}

export default function scenario() {
  const roll = Math.random();
  let res;
  if (roll < 0.59) {
    const offset = 20 * Math.floor(Math.random() * 50);
    const id = userId();
    res = http.get(`${target}/api/articles?limit=20&offset=${offset}`, requestParams('GET /api/articles', id, false));
  } else if (roll < 0.79) {
    const id = userId();
    const slug = `article-${articleNumber()}`;
    res = http.get(`${target}/api/articles/${slug}`, requestParams('GET /api/articles/:slug', id, false));
  } else if (roll < 0.89) {
    const id = userId();
    const profileId = userId();
    res = http.get(
      `${target}/api/profiles/user${profileId}`,
      requestParams('GET /api/profiles/:username', id, false)
    );
  } else if (roll < 0.99) {
    const id = userId();
    const slug = `article-${articleNumber()}`;
    const payload = JSON.stringify({ comment: { body: COMMENT_BODY } });
    res = http.post(
      `${target}/api/articles/${slug}/comments`,
      payload,
      requestParams('POST /api/articles/:slug/comments', id, true)
    );
  } else {
    const id = userId();
    const payload = JSON.stringify({
      user: { email: `user${id}@example.test`, password: PASSWORD },
    });
    res = http.post(`${target}/api/users/login`, payload, requestParams('POST /api/users/login', id, true));
  }

  const errorClass = recordErrorClass(res);
  check(res, {
    'status is 2xx or classified error': (r) =>
      (r.status >= 200 && r.status < 300) || errorClass !== null,
  });
}

export function handleSummary(data) {
  return handleRunSummary(data);
}
