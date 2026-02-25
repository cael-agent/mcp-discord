import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LOGIN_TIMEOUT_MS,
  connectionState,
  main,
  requireDiscordConnection,
  resetConnectionStateForTests,
} from './index.js';

test('requireDiscordConnection allows calls when Discord is ready', () => {
  resetConnectionStateForTests();

  assert.doesNotThrow(() =>
    requireDiscordConnection({
      isReady: () => true,
      now: () => 1_000,
    })
  );

  assert.equal(connectionState.status, 'connected');
  assert.equal(connectionState.connectedAt, 1_000);
  assert.equal(connectionState.error, null);
});

test('requireDiscordConnection throws while Discord is still connecting', () => {
  resetConnectionStateForTests();
  connectionState.status = 'connecting';
  connectionState.loginStartedAt = Date.now();

  assert.throws(
    () =>
      requireDiscordConnection({
        isReady: () => false,
        now: () => connectionState.loginStartedAt! + 1_000,
      }),
    /Discord is still connecting/
  );
});

test('requireDiscordConnection throws when Discord is in error state', () => {
  resetConnectionStateForTests();
  connectionState.status = 'error';
  connectionState.error = new Error('bad gateway');

  assert.throws(
    () =>
      requireDiscordConnection({
        isReady: () => false,
      }),
    /Discord connection failed: bad gateway\. Server restart required\./
  );
});

test('requireDiscordConnection detects timeout and transitions to error state', () => {
  resetConnectionStateForTests();

  const now = 50_000;
  connectionState.status = 'connecting';
  connectionState.loginStartedAt = now - LOGIN_TIMEOUT_MS - 1;

  assert.throws(
    () =>
      requireDiscordConnection({
        isReady: () => false,
        now: () => now,
      }),
    /Discord login timeout/
  );

  assert.equal(connectionState.status, 'error');
  assert.match(connectionState.error?.message ?? '', /Discord login timeout/);
});

test('main sets up MCP transport before starting Discord login', async () => {
  resetConnectionStateForTests();

  const calls: string[] = [];

  await main({
    token: 'test-token',
    guildId: '123456789012345678',
    now: () => 2_000,
    log: () => {},
    connectMcpTransport: async () => {
      calls.push('connect');
    },
    startDiscordLogin: async () => {
      calls.push('login');
      return 'ok';
    },
  });

  assert.deepEqual(calls, ['connect', 'login']);
  assert.equal(connectionState.loginStartedAt, 2_000);
});
