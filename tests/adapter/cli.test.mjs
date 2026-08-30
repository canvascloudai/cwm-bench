import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs, usageText } from '../../scripts/lib/adapter/cli.mjs';
import { main } from '../../scripts/lib/adapter/main.mjs';
import { MemoryStream } from '../helpers.mjs';

test('parseArgs: wait-ready --json', () => {
  const parsed = parseArgs(['wait-ready', '--json']);
  assert.equal(parsed.command, 'wait-ready');
  assert.equal(parsed.json, true);
  assert.equal(parsed.scenario, null);
});

test('parseArgs: run --scenario idle --json', () => {
  const parsed = parseArgs(['run', '--scenario', 'idle', '--json']);
  assert.equal(parsed.command, 'run');
  assert.equal(parsed.scenario, 'idle');
  assert.equal(parsed.json, true);
});

test('parseArgs: collect --scenario=peak --json', () => {
  const parsed = parseArgs(['collect', '--scenario=peak', '--json']);
  assert.equal(parsed.command, 'collect');
  assert.equal(parsed.scenario, 'peak');
});

test('parseArgs: unknown command throws', () => {
  assert.throws(() => parseArgs(['provision', '--json']), (err) => err.code === 'UNKNOWN_COMMAND');
});

test('parseArgs: run without scenario throws', () => {
  assert.throws(() => parseArgs(['run', '--json']), (err) => err.code === 'INVALID_ARGS');
});

test('parseArgs: --help', () => {
  const parsed = parseArgs(['--help']);
  assert.equal(parsed.help, true);
  assert.equal(parsed.command, 'help');
});

test('usage text documents the three worker commands and holdouts', () => {
  const text = usageText();
  assert.match(text, /wait-ready --json/);
  assert.match(text, /run --scenario/);
  assert.match(text, /collect --scenario/);
  assert.match(text, /later-day/);
  assert.match(text, /second-region/);
  assert.match(text, /us-west-2/);
});

test('main: unknown command fails with JSON error', async () => {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  const code = await main(['not-a-command', '--json'], { stdout, stderr });
  assert.equal(code, 1);
  const payload = JSON.parse(stdout.toString());
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'UNKNOWN_COMMAND');
  assert.equal(stderr.toString(), '');
});

test('main: missing command fails', async () => {
  const stdout = new MemoryStream();
  const code = await main(['--json'], { stdout, stderr: new MemoryStream() });
  assert.equal(code, 1);
  const payload = JSON.parse(stdout.toString());
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'UNKNOWN_COMMAND');
});

test('main: unknown scenario fails', async () => {
  const stdout = new MemoryStream();
  const code = await main(['run', '--scenario', 'not-a-real-scenario', '--json'], {
    stdout,
    stderr: new MemoryStream(),
    deps: {
      runTerraform: async () => {
        throw new Error('terraform should not run for unknown scenario');
      },
    },
  });
  assert.equal(code, 1);
  const payload = JSON.parse(stdout.toString());
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'UNKNOWN_SCENARIO');
  assert.equal(payload.scenario, 'not-a-real-scenario');
});

test('main: --help exits 0', async () => {
  const stdout = new MemoryStream();
  const code = await main(['--help'], { stdout, stderr: new MemoryStream() });
  assert.equal(code, 0);
  assert.match(stdout.toString(), /worker adapter/);
});
