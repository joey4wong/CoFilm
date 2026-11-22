import test from 'node:test';
import assert from 'node:assert/strict';
import { helixOrder } from '../lib/helix.mjs';

test('helixOrder puts films oldest first, keeps library order within a year, and sends unknown years to the end', () => {
  const items = [{ key: 'b', y: '1990' }, { key: 'x', y: '' }, { key: 'a', y: '1951' }, { key: 'c', y: '1990' }];
  assert.deepEqual(helixOrder(items, it => it.y).map(it => it.key), ['a', 'b', 'c', 'x']);
});
