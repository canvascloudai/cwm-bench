'use strict';

/**
 * Stateless HS256 tokens for the typical workload.
 * The key is a public benchmark constant, not a secret.
 * Load-script tokens use TOKEN_IAT and TOKEN_EXP. Login signs a new iat.
 */

const crypto = require('node:crypto');

const TOKEN_KEY = 'cwm-bench-typical-hs256-key';
const TOKEN_HEADER_JSON = '{"alg":"HS256","typ":"JWT"}';
const TOKEN_IAT = 1767225600;
const TOKEN_EXP = 4102444800;

function signToken(payload) {
  const sub = String(payload.sub);
  const username = String(payload.username);
  const iat = Number(payload.iat);
  const exp = Number(payload.exp);
  const header = Buffer.from(TOKEN_HEADER_JSON).toString('base64url');
  const bodyJson = `{"sub":"${sub}","username":"${username}","iat":${iat},"exp":${exp}}`;
  const body = Buffer.from(bodyJson).toString('base64url');
  const data = `${header}.${body}`;
  const signature = crypto.createHmac('sha256', TOKEN_KEY).update(data).digest('base64url');
  return `${data}.${signature}`;
}

function tokenForUser(userId) {
  const id = Number(userId);
  return signToken({
    sub: id,
    username: `user${id}`,
    iat: TOKEN_IAT,
    exp: TOKEN_EXP,
  });
}

function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error('invalid token');
  }
  const [header, payload, signature] = parts;
  const data = `${header}.${payload}`;
  const expected = crypto.createHmac('sha256', TOKEN_KEY).update(data).digest();
  let actual;
  try {
    actual = Buffer.from(signature, 'base64url');
  } catch (_err) {
    throw new Error('invalid token');
  }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new Error('invalid token');
  }
  let body;
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch (_err) {
    throw new Error('invalid token');
  }
  const exp = Number(body.exp);
  if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) {
    throw new Error('invalid token');
  }
  const sub = Number(body.sub);
  if (!Number.isInteger(sub) || sub < 1 || typeof body.username !== 'string' || body.username.length < 1) {
    throw new Error('invalid token');
  }
  return { sub, username: body.username, iat: body.iat, exp };
}

module.exports = {
  TOKEN_KEY,
  TOKEN_HEADER_JSON,
  TOKEN_IAT,
  TOKEN_EXP,
  signToken,
  tokenForUser,
  verifyToken,
};
