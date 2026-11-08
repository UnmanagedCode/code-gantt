import test from 'node:test';
import assert from 'node:assert/strict';
import { LINK_TYPES } from '../../src/model/linkTypes.js';
import { LINK_GROUPS, CATCH_ALL_GROUP, groupLinkItems } from '../../public/lib/linkGroups.js';
import { HEARTBEAT_KEY } from '../../public/lib/filterModel.js';

const members = LINK_GROUPS.flatMap((g) => g.members);

test('guard: every server link type is in exactly one group', () => {
  for (const t of LINK_TYPES) assert.equal(members.filter((m) => m === t).length, 1, t);
});

test('the table holds only link types plus the heartbeat pseudo-key, and heartbeat is not a link type', () => {
  assert.equal(LINK_TYPES.includes(HEARTBEAT_KEY), false);
  for (const m of members) assert.ok(LINK_TYPES.includes(m) || m === HEARTBEAT_KEY, m);
  assert.equal(members.filter((m) => m === HEARTBEAT_KEY).length, 1);
});

test('groupLinkItems keeps table order, omits empty groups and puts unknown keys last in the catch-all', () => {
  const item = (key) => ({ key, label: key });
  const out = groupLinkItems(['zzz', 'wake', 'spawn', 'other', 'yyy'].map(item));
  assert.deepEqual(out.map((g) => g.id), ['lifecycle', 'wakes', CATCH_ALL_GROUP]);
  assert.deepEqual(out.at(-1).items.map((i) => i.key), ['other', 'zzz', 'yyy']);
});
