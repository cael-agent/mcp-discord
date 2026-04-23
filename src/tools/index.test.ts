import assert from 'node:assert/strict';
import test from 'node:test';

import { tools } from './index.js';

test('tools array includes preview_discord as the final entry with the expected schema', () => {
  const entry = tools.at(-1);
  const properties = (entry?.inputSchema.properties ?? {}) as Record<string, {
    type?: string;
    default?: number;
    minimum?: number;
    maximum?: number;
  }>;

  assert.ok(entry, 'expected a final tool entry');
  assert.equal(entry?.name, 'preview_discord');
  assert.equal(entry?.inputSchema.type, 'object');
  assert.equal(entry?.inputSchema.additionalProperties, false);
  assert.deepEqual(entry?.inputSchema.required ?? [], []);
  assert.deepEqual(
    Object.keys(properties).sort(),
    ['channel', 'limit', 'since'],
  );
  assert.equal(properties.channel?.type, 'string');
  assert.equal(properties.since?.type, 'string');
  assert.equal(properties.limit?.type, 'number');
  assert.equal(properties.limit?.default, 3);
  assert.equal(properties.limit?.minimum, 1);
  assert.equal(properties.limit?.maximum, 10);
  assert.match(entry?.description ?? '', /grouped by channel/i);
  assert.match(entry?.description ?? '', /bot/i);
  assert.match(entry?.description ?? '', /read_channel/i);
  assert.match(entry?.description ?? '', /bypass/i);
});
