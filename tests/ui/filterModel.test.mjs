import test from 'node:test';
import assert from 'node:assert/strict';
import { dimensionItems, selectedKeys, applySelection, listedProjects, emptyHint, HEARTBEAT_KEY } from '../../public/lib/filterModel.js';
import { applyFilters, defaultFilters } from '../../public/lib/layout.js';

const S = (id, extra = {}) => ({ id, start: 100, end: 900, endKind: 'exited', turns: [], stages: [], rotations: [], marks: [], turnCount: 0, ...extra });
const payload = () => ({
  now: 10_000, window: { from: 0, to: 10_000 },
  linkTypes: ['spawn', 'send_prompt', 'wake'],
  projects: [
    { project: 'A', trees: [{ rootId: 'r', rows: [{ id: 'r', depth: 0, context: true }, { id: 'a1', depth: 1, context: false }] }] },
    { project: 'B', trees: [{ rootId: 'r2', rows: [{ id: 'r2', depth: 0, context: true }, { id: 'b1', depth: 1, context: false }] }] },
  ],
  sessions: { r: S('r', { title: 'Root' }), a1: S('a1'), r2: S('r2'), b1: S('b1') },
  links: [
    { ts: 150, type: 'spawn', from: 'r', to: 'a1' },
    { ts: 160, type: 'send_prompt', from: 'r2', to: 'b1' },
    { ts: 170, type: 'wake', from: 'a1', to: 'r' },
    { ts: 180, type: 'wake', from: 'a1', to: 'r', heartbeat: true },
  ],
});

test('dimensionItems appends the heartbeat item; tree labels use the title and fall back to the id', () => {
  const items = dimensionItems(payload());
  assert.deepEqual(items.links.map((i) => i.key), ['spawn', 'send_prompt', 'wake', HEARTBEAT_KEY]);
  assert.deepEqual(items.projects.map((i) => i.key), ['A', 'B']);
  assert.deepEqual(items.roots.map((i) => i.label), ['Root', 'r2']);
});

test('selectedKeys: null means every item; links merge the heartbeat flag', () => {
  const p = payload();
  const items = dimensionItems(p);
  const f = defaultFilters(p);
  assert.deepEqual([...selectedKeys(f, 'projects', items.projects)], ['A', 'B']);
  assert.equal(selectedKeys(f, 'links', items.links).has(HEARTBEAT_KEY), true);
  f.heartbeat = false;
  assert.equal(selectedKeys(f, 'links', items.links).has(HEARTBEAT_KEY), false);
});

test('applySelection: all keys → null, subset → Set, empty → empty Set, stale keys survive', () => {
  const p = payload();
  const items = dimensionItems(p);
  const f = defaultFilters(p);
  applySelection(f, 'projects', items.projects, new Set(['A', 'B']));
  assert.equal(f.projects, null);
  applySelection(f, 'projects', items.projects, new Set(['A']));
  assert.deepEqual([...f.projects], ['A']);
  applySelection(f, 'projects', items.projects, new Set());
  assert.equal(f.projects instanceof Set && f.projects.size, 0);
  applySelection(f, 'roots', items.roots, new Set(['r', 'gone']));
  assert.deepEqual([...f.roots].sort(), ['gone', 'r']);
  applySelection(f, 'roots', items.roots, new Set(['r', 'r2', 'gone']));
  assert.equal(f.roots, null);
});

test('applySelection splits links into linkTypes and the heartbeat flag', () => {
  const p = payload();
  const items = dimensionItems(p);
  const f = defaultFilters(p);
  applySelection(f, 'links', items.links, new Set(['wake', HEARTBEAT_KEY]));
  assert.deepEqual([...f.linkTypes], ['wake']);
  assert.equal(f.heartbeat, true);
  applySelection(f, 'links', items.links, new Set(['spawn']));
  assert.equal(f.heartbeat, false);
});

test('a selectedKeys → applySelection round trip leaves applyFilters output unchanged', () => {
  const p = payload();
  const items = dimensionItems(p);
  const variants = [
    (f) => f,
    (f) => { f.projects = new Set(['A']); },
    (f) => { f.roots = new Set(['r2']); },
    (f) => { f.linkTypes.delete('wake'); },
    (f) => { f.heartbeat = false; },
    (f) => { f.projects = new Set(['A', 'gone']); },
    (f) => { f.roots = new Set(['r', 'gone']); },
  ];
  for (const mutate of variants) {
    const f = defaultFilters(p);
    mutate(f);
    const g = { ...f, linkTypes: new Set(f.linkTypes) };
    for (const dim of ['projects', 'roots', 'links']) applySelection(g, dim, items[dim], selectedKeys(g, dim, items[dim]));
    assert.deepEqual(applyFilters(p, g), applyFilters(p, f));
  }
});

test('selectedKeys keeps stored keys that are not in the current items', () => {
  const p = payload();
  const items = dimensionItems(p);
  const f = defaultFilters(p);
  f.projects = new Set(['A', 'gone']);
  f.roots = new Set(['r', 'gone']);
  assert.equal(selectedKeys(f, 'projects', items.projects).has('gone'), true);
  assert.equal(selectedKeys(f, 'roots', items.roots).has('gone'), true);
});

test('dimensionItems lists a root once when it appears under two projects', () => {
  const p = payload();
  p.projects[1].trees.push({ rootId: 'r', rows: [{ id: 'r', depth: 0, context: true }] });
  const keys = dimensionItems(p).roots.map((i) => i.key);
  assert.deepEqual(keys, ['r', 'r2']);
});

test('isAll: null means All for projects/roots, an explicit Set never does; links go by count', async () => {
  const { isAll } = await import('../../public/lib/filterModel.js');
  const p = payload();
  const items = dimensionItems(p);
  const f = defaultFilters(p);
  assert.equal(isAll(f, 'projects', items.projects), true);
  f.projects = new Set(['A', 'B']);
  assert.equal(isAll(f, 'projects', items.projects), false);
  assert.equal(isAll(f, 'roots', items.roots), true);
  f.roots = new Set(['r', 'r2']);
  assert.equal(isAll(f, 'roots', items.roots), false);
  assert.equal(isAll(f, 'links', items.links), true);
  f.heartbeat = false;
  assert.equal(isAll(f, 'links', items.links), false);
});

// r sits under A and C; r2 under B.
const spanning = () => {
  const p = payload();
  p.projects.push({ project: 'C', trees: [{ rootId: 'r', rows: [{ id: 'r', depth: 0, context: true }] }] });
  return p;
};
const listed = (p, roots) => listedProjects(p, { ...defaultFilters(p), roots }, dimensionItems(p).projects).map((i) => i.key);

test('listedProjects: null roots lists every project; a subset lists the projects its trees touch, in payload order', () => {
  const p = spanning();
  assert.deepEqual(listedProjects(p, defaultFilters(p), dimensionItems(p).projects), dimensionItems(p).projects);
  assert.deepEqual(listed(p, new Set(['r'])), ['A', 'C']);
  assert.deepEqual(listed(p, new Set(['r2'])), ['B']);
  assert.deepEqual(listed(p, new Set()), []);
  assert.deepEqual(listed(p, new Set(['gone'])), []);
});

test('emptyHint names the empty filter and falls back to a generic text; the three differ', () => {
  const p = spanning();
  const hint = (over) => emptyHint(p, { ...defaultFilters(p), ...over });
  const conductors = hint({ roots: new Set() });
  const projects = hint({ roots: new Set(['r']), projects: new Set(['B']) });
  const generic = hint({ roots: new Set(['r']), projects: new Set(['A']) });
  assert.match(conductors, /conductor/i);
  assert.match(projects, /project/i);
  assert.equal(hint({ roots: new Set(['gone']) }), conductors);
  assert.equal(hint({ projects: new Set() }), projects);
  assert.equal(new Set([conductors, projects, generic]).size, 3);
});
