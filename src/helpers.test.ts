import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampMessageLimit,
  MentionTracker,
  parseHexColor,
  resolveChannelId,
  type TrackedMention,
} from './helpers.js';

const CHANNEL_MAP = {
  cael: '111111111111111111',
  general: '222222222222222222',
  'tool-requests': '333333333333333333',
  logs: '444444444444444444',
};

function makeMention(overrides: Partial<TrackedMention> = {}): TrackedMention {
  return {
    messageId: 'm1',
    channelId: 'c1',
    channelName: 'general',
    author: 'james',
    content: 'hello',
    timestamp: 1_000,
    ...overrides,
  };
}

test('resolveChannelId maps names case-insensitively', () => {
  assert.equal(resolveChannelId('CAEL', CHANNEL_MAP), CHANNEL_MAP.cael);
  assert.equal(resolveChannelId('general', CHANNEL_MAP), CHANNEL_MAP.general);
});

test('resolveChannelId passes through snowflake IDs', () => {
  const snowflake = '123456789012345678';
  assert.equal(resolveChannelId(snowflake, CHANNEL_MAP), snowflake);
});

test('resolveChannelId throws for unknown names with available list', () => {
  assert.throws(() => resolveChannelId('unknown-room', CHANNEL_MAP), /Available channels: cael, general, logs, tool-requests/);
});

test('resolveChannelId throws for empty string', () => {
  assert.throws(() => resolveChannelId('   ', CHANNEL_MAP), /channel must not be empty/);
});

test('clampMessageLimit uses default value when omitted', () => {
  assert.equal(clampMessageLimit(undefined), 20);
});

test('clampMessageLimit clamps values above max', () => {
  assert.equal(clampMessageLimit(200), 50);
});

test('clampMessageLimit rejects zero and negative values', () => {
  assert.throws(() => clampMessageLimit(0), /limit must be at least 1/);
  assert.throws(() => clampMessageLimit(-4), /limit must be at least 1/);
});

test('clampMessageLimit floors non-integer values', () => {
  assert.equal(clampMessageLimit(19.9), 19);
});

test('MentionTracker stores and returns mentions', () => {
  const tracker = new MentionTracker();
  const mention = makeMention();

  tracker.addMention(mention, mention.timestamp);

  assert.deepEqual(tracker.getMentions(), [mention]);
});

test('MentionTracker filters by since timestamp', () => {
  const tracker = new MentionTracker();
  const oldMention = makeMention({ messageId: 'old', timestamp: 1_000 });
  const newMention = makeMention({ messageId: 'new', timestamp: 2_000 });

  tracker.addMention(oldMention, oldMention.timestamp);
  tracker.addMention(newMention, newMention.timestamp);

  assert.deepEqual(tracker.getMentions(new Date(1_500).toISOString()), [newMention]);
});

test('MentionTracker auto-cleans mentions older than max age', () => {
  const tracker = new MentionTracker(1_000);
  const first = makeMention({ messageId: 'old', timestamp: 1_000 });
  const second = makeMention({ messageId: 'new', timestamp: 2_100 });

  tracker.addMention(first, 1_000);
  tracker.addMention(second, 2_100);

  assert.deepEqual(tracker.getMentions(), [second]);
});

test('MentionTracker returns empty list when no mentions exist', () => {
  const tracker = new MentionTracker();
  assert.deepEqual(tracker.getMentions(), []);
});

test('parseHexColor supports values with and without hash', () => {
  assert.equal(parseHexColor('#5865F2'), 0x5865f2);
  assert.equal(parseHexColor('5865F2'), 0x5865f2);
});

test('parseHexColor throws on invalid values', () => {
  assert.throws(() => parseHexColor('not-a-color'), /6-digit hex/);
  assert.throws(() => parseHexColor('#12345'), /6-digit hex/);
});
