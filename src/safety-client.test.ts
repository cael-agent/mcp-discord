import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_SAFETY_TIMEOUT_MS } from './safety-client.js';

test('DEFAULT_SAFETY_TIMEOUT_MS is pinned to the preview-first timeout default', () => {
  assert.equal(DEFAULT_SAFETY_TIMEOUT_MS, 520_000);
});
