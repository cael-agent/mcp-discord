import assert from 'node:assert/strict';
import { readFile, rm, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  getChannelHighwater,
  getDefaultStatePath,
  loadHighwater,
  saveHighwater,
  updateMultipleHighwaters,
} from './highwater.js';

async function makeTmpDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'hw-test-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('loadHighwater returns empty state when file does not exist', async (t) => {
  const dir = await makeTmpDir(t);
  const state = await loadHighwater(path.join(dir, 'missing.json'));
  assert.deepEqual(state, { channels: {} });
});

test('loadHighwater returns parsed state from valid JSON file', async (t) => {
  const dir = await makeTmpDir(t);
  const filePath = path.join(dir, 'hw.json');
  const expected = { channels: { '111': '999', '222': '888' } };
  await writeFile(filePath, JSON.stringify(expected), 'utf-8');

  const state = await loadHighwater(filePath);
  assert.deepEqual(state, expected);
});

test('loadHighwater returns empty state when file contains invalid JSON', async (t) => {
  const dir = await makeTmpDir(t);
  const filePath = path.join(dir, 'hw.json');
  await writeFile(filePath, 'not json!!!', 'utf-8');

  const state = await loadHighwater(filePath);
  assert.deepEqual(state, { channels: {} });
});

test('loadHighwater returns empty state when JSON has wrong shape', async (t) => {
  const dir = await makeTmpDir(t);
  const filePath = path.join(dir, 'hw.json');
  await writeFile(filePath, JSON.stringify({ something: 'else' }), 'utf-8');

  const state = await loadHighwater(filePath);
  assert.deepEqual(state, { channels: {} });
});

test('loadHighwater returns empty state when channels is an array', async (t) => {
  const dir = await makeTmpDir(t);
  const filePath = path.join(dir, 'hw.json');
  await writeFile(filePath, JSON.stringify({ channels: [1, 2, 3] }), 'utf-8');

  const state = await loadHighwater(filePath);
  assert.deepEqual(state, { channels: {} });
});

test('saveHighwater creates parent directories and writes valid JSON', async (t) => {
  const dir = await makeTmpDir(t);
  const filePath = path.join(dir, 'nested', 'deep', 'hw.json');
  const state = { channels: { '111': '999' } };

  await saveHighwater(filePath, state);

  const raw = await readFile(filePath, 'utf-8');
  assert.deepEqual(JSON.parse(raw), state);
});

test('saveHighwater overwrites existing file', async (t) => {
  const dir = await makeTmpDir(t);
  const filePath = path.join(dir, 'hw.json');
  await writeFile(filePath, JSON.stringify({ channels: { '111': '100' } }), 'utf-8');

  const newState = { channels: { '111': '999', '222': '888' } };
  await saveHighwater(filePath, newState);

  const raw = await readFile(filePath, 'utf-8');
  assert.deepEqual(JSON.parse(raw), newState);
});

test('getChannelHighwater returns undefined for unknown channel', () => {
  const state = { channels: { '111': '999' } };
  assert.equal(getChannelHighwater(state, '222'), undefined);
});

test('getChannelHighwater returns stored snowflake for known channel', () => {
  const state = { channels: { '111': '999' } };
  assert.equal(getChannelHighwater(state, '111'), '999');
});

test('updateMultipleHighwaters merges updates without mutating original', () => {
  const original = { channels: { '111': '100', '222': '200' } };
  const updated = updateMultipleHighwaters(original, { '222': '999', '333': '300' });

  assert.deepEqual(updated, { channels: { '111': '100', '222': '999', '333': '300' } });
  assert.deepEqual(original, { channels: { '111': '100', '222': '200' } });
});

test('getDefaultStatePath returns env var when set', (t) => {
  const original = process.env.DISCORD_STATE_PATH;
  t.after(() => {
    if (original === undefined) {
      delete process.env.DISCORD_STATE_PATH;
    } else {
      process.env.DISCORD_STATE_PATH = original;
    }
  });

  process.env.DISCORD_STATE_PATH = '/custom/path.json';
  assert.equal(getDefaultStatePath(), '/custom/path.json');
});

test('getDefaultStatePath returns default when env var is not set', (t) => {
  const original = process.env.DISCORD_STATE_PATH;
  t.after(() => {
    if (original === undefined) {
      delete process.env.DISCORD_STATE_PATH;
    } else {
      process.env.DISCORD_STATE_PATH = original;
    }
  });

  delete process.env.DISCORD_STATE_PATH;
  assert.equal(getDefaultStatePath(), 'data/highwater.json');
});
