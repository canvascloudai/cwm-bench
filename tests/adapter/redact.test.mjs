import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main } from '../../scripts/lib/adapter/main.mjs';
import { redact } from '../../scripts/lib/adapter/redact.mjs';
import { MemoryStream, createAwsMock, terraformOutputFixture } from '../helpers.mjs';

test('redact strips AWS and database secrets', () => {
  const raw = [
    'AWS_ACCESS_KEY_ID=AKIAAAAAAAAAAAAAAAAA',
    'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    'MYSQL_PASSWORD=super-secret-db-pass',
    'MYSQL_PWD=another-secret',
    'mysql://cwmbench:hunter2@db.example:3306/cwmbench',
  ].join('\n');
  const cleaned = redact(raw);
  assert.doesNotMatch(cleaned, /AKIAAAAAAAAAAAAAAAAA/);
  assert.doesNotMatch(cleaned, /wJalrXUtnFEMI/);
  assert.doesNotMatch(cleaned, /super-secret-db-pass/);
  assert.doesNotMatch(cleaned, /another-secret/);
  assert.doesNotMatch(cleaned, /hunter2/);
  assert.match(cleaned, /REDACTED/);
});

test('redact leaves lowercase git SHAs intact', () => {
  const sha = 'e95c5319b5c7b9cbd934735241b355df4144cab0';
  assert.equal(redact(`cleanup pin ${sha}`), `cleanup pin ${sha}`);
});

test('adapter JSON error redacts leaked credentials from AWS stderr', async () => {
  const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  const aws = createAwsMock({
    default: async () => ({
      code: 1,
      stdout: '',
      stderr: `AccessDenied AWS_SECRET_ACCESS_KEY=${secret} MYSQL_PASSWORD=hunter2`,
    }),
  });
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  const code = await main(['run', '--scenario', 'normal', '--json'], {
    stdout,
    stderr,
    now: () => new Date('2026-09-01T00:00:00.000Z'),
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture(), stderr: '' }),
    },
  });
  assert.equal(code, 1);
  const combined = `${stdout.toString()}\n${stderr.toString()}`;
  assert.doesNotMatch(combined, /wJalrXUtnFEMI/);
  assert.doesNotMatch(combined, /hunter2/);
  const payload = JSON.parse(stdout.toString());
  assert.equal(payload.ok, false);
  assert.match(payload.error.message, /REDACTED|AccessDenied/i);
});

test('terraform failure with a connection string is redacted', async () => {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  const code = await main(['collect', '--scenario', 'idle', '--json'], {
    stdout,
    stderr,
    deps: {
      runTerraform: async () => ({
        code: 1,
        stdout: '',
        stderr: 'failed mysql://cwmbench:s3cretpass@localhost:3306/cwmbench',
      }),
    },
  });
  assert.equal(code, 1);
  const combined = `${stdout.toString()}\n${stderr.toString()}`;
  assert.doesNotMatch(combined, /s3cretpass/);
  assert.doesNotMatch(combined, /mysql:\/\/cwmbench/);
});
