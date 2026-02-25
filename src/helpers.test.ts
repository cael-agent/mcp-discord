import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampMessageLimit,
  MentionTracker,
  parseHexColor,
  parseOptionalTimestamp,
  resolveChannelId,
  splitMessage,
  validateButtons,
  validateEmbedFields,
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

test('validateButtons accepts valid single-button input', () => {
  const buttons = validateButtons([
    { id: 'approve', label: 'Approve', style: 'success' },
  ]);

  assert.deepEqual(buttons, [{ id: 'approve', label: 'Approve', style: 'success' }]);
});

test('validateButtons accepts up to five buttons', () => {
  const buttons = validateButtons([
    { id: 'b1', label: 'One', style: 'primary' },
    { id: 'b2', label: 'Two', style: 'secondary' },
    { id: 'b3', label: 'Three', style: 'success' },
    { id: 'b4', label: 'Four', style: 'danger' },
    { id: 'b5', label: 'Five', style: 'primary' },
  ]);

  assert.equal(buttons.length, 5);
});

test('validateButtons throws on empty array', () => {
  assert.throws(() => validateButtons([]), /non-empty array/);
});

test('validateButtons throws when more than five buttons are provided', () => {
  assert.throws(
    () =>
      validateButtons([
        { id: 'b1', label: 'One', style: 'primary' },
        { id: 'b2', label: 'Two', style: 'primary' },
        { id: 'b3', label: 'Three', style: 'primary' },
        { id: 'b4', label: 'Four', style: 'primary' },
        { id: 'b5', label: 'Five', style: 'primary' },
        { id: 'b6', label: 'Six', style: 'primary' },
      ]),
    /at most 5 entries/
  );
});

test('validateButtons throws on duplicate IDs', () => {
  assert.throws(
    () =>
      validateButtons([
        { id: 'approve', label: 'Approve', style: 'success' },
        { id: 'approve', label: 'Deny', style: 'danger' },
      ]),
    /duplicate button id/
  );
});

test('validateButtons throws on missing or empty id', () => {
  assert.throws(
    () => validateButtons([{ label: 'Approve', style: 'success' }] as unknown),
    /non-empty string id/
  );
  assert.throws(
    () => validateButtons([{ id: '  ', label: 'Approve', style: 'success' }]),
    /non-empty string id/
  );
});

test('validateButtons throws on missing or empty label', () => {
  assert.throws(
    () => validateButtons([{ id: 'approve', style: 'success' }] as unknown),
    /non-empty string label/
  );
  assert.throws(
    () => validateButtons([{ id: 'approve', label: ' ', style: 'success' }]),
    /non-empty string label/
  );
});

test('validateButtons throws when id exceeds 100 characters', () => {
  assert.throws(
    () =>
      validateButtons([
        { id: 'a'.repeat(101), label: 'Approve', style: 'success' },
      ]),
    /exceeds 100 character limit/
  );
});

test('validateButtons throws when label exceeds 80 characters', () => {
  assert.throws(
    () =>
      validateButtons([
        { id: 'approve', label: 'a'.repeat(81), style: 'success' },
      ]),
    /exceeds 80 character limit/
  );
});

test('validateButtons throws on invalid style', () => {
  assert.throws(
    () =>
      validateButtons([
        { id: 'approve', label: 'Approve', style: 'neutral' },
      ]),
    /button style must be one of/
  );
});

test('validateEmbedFields returns undefined when omitted', () => {
  assert.equal(validateEmbedFields(undefined), undefined);
  assert.equal(validateEmbedFields(null), undefined);
});

test('validateEmbedFields accepts valid fields', () => {
  const result = validateEmbedFields([
    { name: 'Status', value: 'Online' },
    { name: 'Region', value: 'US-East', inline: true },
  ]);

  assert.deepEqual(result, [
    { name: 'Status', value: 'Online', inline: false },
    { name: 'Region', value: 'US-East', inline: true },
  ]);
});

test('validateEmbedFields throws on non-array input', () => {
  assert.throws(() => validateEmbedFields('not-an-array'), /fields must be an array/);
});

test('validateEmbedFields throws when more than 25 fields', () => {
  const fields = Array.from({ length: 26 }, (_, i) => ({ name: `f${i}`, value: `v${i}` }));
  assert.throws(() => validateEmbedFields(fields), /at most 25 entries/);
});

test('validateEmbedFields throws on missing or empty name', () => {
  assert.throws(
    () => validateEmbedFields([{ value: 'v' }] as unknown),
    /non-empty string name/
  );
  assert.throws(
    () => validateEmbedFields([{ name: '  ', value: 'v' }]),
    /non-empty string name/
  );
});

test('validateEmbedFields throws on missing or empty value', () => {
  assert.throws(
    () => validateEmbedFields([{ name: 'n' }] as unknown),
    /non-empty string value/
  );
  assert.throws(
    () => validateEmbedFields([{ name: 'n', value: ' ' }]),
    /non-empty string value/
  );
});

test('validateEmbedFields throws when name exceeds 256 characters', () => {
  assert.throws(
    () => validateEmbedFields([{ name: 'a'.repeat(257), value: 'v' }]),
    /exceeds 256 character limit/
  );
});

test('validateEmbedFields throws when value exceeds 1024 characters', () => {
  assert.throws(
    () => validateEmbedFields([{ name: 'n', value: 'a'.repeat(1025) }]),
    /exceeds 1024 character limit/
  );
});

test('validateEmbedFields throws when inline is not a boolean', () => {
  assert.throws(
    () => validateEmbedFields([{ name: 'n', value: 'v', inline: 'yes' }]),
    /field inline must be a boolean/
  );
});

test('parseOptionalTimestamp returns numeric timestamp for valid ISO string', () => {
  const iso = '2026-02-18T12:00:00.000Z';
  assert.equal(parseOptionalTimestamp(iso), new Date(iso).getTime());
});

test('parseOptionalTimestamp returns undefined when omitted', () => {
  assert.equal(parseOptionalTimestamp(undefined), undefined);
});

test('parseOptionalTimestamp throws on invalid string', () => {
  assert.throws(() => parseOptionalTimestamp('not-a-time'), /valid ISO 8601 timestamp/);
});

// splitMessage tests

test('splitMessage returns single-element array for short text', () => {
  assert.deepEqual(splitMessage('hello'), ['hello']);
});

test('splitMessage returns single-element array for text exactly at limit', () => {
  const text = 'a'.repeat(2000);
  const parts = splitMessage(text);
  assert.equal(parts.length, 1);
  assert.equal(parts[0], text);
});

test('splitMessage splits at newline when available', () => {
  const line1 = 'a'.repeat(1500);
  const line2 = 'b'.repeat(800);
  const text = `${line1}\n${line2}`;

  const parts = splitMessage(text);
  assert.equal(parts.length, 2);
  assert.equal(parts[0], line1);
  assert.equal(parts[1], line2);
});

test('splitMessage splits at space when no newline available', () => {
  const word1 = 'a'.repeat(1500);
  const word2 = 'b'.repeat(800);
  const text = `${word1} ${word2}`;

  const parts = splitMessage(text);
  assert.equal(parts.length, 2);
  assert.equal(parts[0], word1);
  assert.equal(parts[1], ` ${word2}`);
});

test('splitMessage hard splits when no whitespace available', () => {
  const text = 'a'.repeat(4500);
  const parts = splitMessage(text);

  assert.equal(parts.length, 3);
  assert.equal(parts[0], 'a'.repeat(2000));
  assert.equal(parts[1], 'a'.repeat(2000));
  assert.equal(parts[2], 'a'.repeat(500));
});

test('splitMessage strips leading newline from remainder', () => {
  const line1 = 'a'.repeat(1990);
  const line2 = 'b'.repeat(10);
  const text = `${line1}\n${line2}`;

  const parts = splitMessage(text);
  assert.equal(parts.length, 2);
  assert.equal(parts[0], line1);
  assert.equal(parts[1], line2); // no leading newline
});

test('splitMessage handles multiple splits across many chunks', () => {
  // 5 lines of 500 chars each, joined by newlines = 2504 chars
  const lines = Array.from({ length: 5 }, (_, i) => String(i).repeat(500));
  const text = lines.join('\n');

  const parts = splitMessage(text);
  // Each part should be <= 2000 chars
  for (const part of parts) {
    assert.ok(part.length <= 2000, `Part exceeds limit: ${part.length}`);
  }
  // Recombined content should match original
  assert.equal(parts.join('\n'), text);
});

test('splitMessage respects custom maxLength', () => {
  const text = 'hello world foo bar';
  const parts = splitMessage(text, 11);

  assert.deepEqual(parts, ['hello world', ' foo bar']);
});
