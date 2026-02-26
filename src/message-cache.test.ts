import assert from 'node:assert/strict';
import test from 'node:test';

import { MessageChannelCache } from './message-cache.js';

test('set and get return correct channelId', () => {
  const cache = new MessageChannelCache();
  cache.set('msg1', 'ch1');
  assert.equal(cache.get('msg1'), 'ch1');
});

test('get returns undefined for unknown messageId', () => {
  const cache = new MessageChannelCache();
  assert.equal(cache.get('unknown'), undefined);
});

test('setMany populates multiple entries', () => {
  const cache = new MessageChannelCache();
  cache.setMany([
    { messageId: 'msg1', channelId: 'ch1' },
    { messageId: 'msg2', channelId: 'ch2' },
    { messageId: 'msg3', channelId: 'ch1' },
  ]);

  assert.equal(cache.get('msg1'), 'ch1');
  assert.equal(cache.get('msg2'), 'ch2');
  assert.equal(cache.get('msg3'), 'ch1');
  assert.equal(cache.size, 3);
});

test('duplicate set does not add duplicate entry', () => {
  const cache = new MessageChannelCache();
  cache.set('msg1', 'ch1');
  cache.set('msg1', 'ch2'); // should be ignored
  assert.equal(cache.get('msg1'), 'ch1');
  assert.equal(cache.size, 1);
});

test('evicts oldest entries when exceeding max size', () => {
  const cache = new MessageChannelCache(3);
  cache.set('msg1', 'ch1');
  cache.set('msg2', 'ch2');
  cache.set('msg3', 'ch3');
  cache.set('msg4', 'ch4'); // should evict msg1

  assert.equal(cache.get('msg1'), undefined);
  assert.equal(cache.get('msg2'), 'ch2');
  assert.equal(cache.get('msg4'), 'ch4');
  assert.equal(cache.size, 3);
});

test('size property is accurate', () => {
  const cache = new MessageChannelCache();
  assert.equal(cache.size, 0);
  cache.set('msg1', 'ch1');
  assert.equal(cache.size, 1);
  cache.set('msg2', 'ch2');
  assert.equal(cache.size, 2);
});
