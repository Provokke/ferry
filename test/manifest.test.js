import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scan, hashBuffer, makeIgnore, globToRegExp, diffManifests, summarise } from '../src/index.js';
import { cleanup, makeTree } from '../support/helpers.js';

test('scan lists files with hashes and sizes, using forward slashes', async () => {
  const dir = await makeTree({ 'a.txt': 'hello', 'sub/deep/b.txt': 'world' });
  try {
    const manifest = await scan(dir);
    assert.deepEqual(Object.keys(manifest), ['a.txt', 'sub/deep/b.txt']);
    assert.equal(manifest['a.txt'].hash, hashBuffer(Buffer.from('hello')));
    assert.equal(manifest['a.txt'].size, 5);
  } finally {
    await cleanup(dir);
  }
});

test('scan honours ignore patterns', async () => {
  const dir = await makeTree({
    'keep.js': '1',
    'node_modules/x/index.js': '2',
    'logs/today.log': '3',
    'src/notes.log': '4',
    'src/main.js': '5'
  });
  try {
    const manifest = await scan(dir, { ignore: ['node_modules/', '*.log'] });
    assert.deepEqual(Object.keys(manifest), ['keep.js', 'src/main.js']);
  } finally {
    await cleanup(dir);
  }
});

test('anchored ignore patterns only match from the root', async () => {
  const dir = await makeTree({ 'build/out.js': '1', 'src/build/out.js': '2' });
  try {
    const manifest = await scan(dir, { ignore: ['/build'] });
    assert.deepEqual(Object.keys(manifest), ['src/build/out.js']);
  } finally {
    await cleanup(dir);
  }
});

test('glob conversion handles star, double star and question mark', () => {
  assert.ok(globToRegExp('*.js').test('a.js'));
  assert.ok(!globToRegExp('*.js').test('dir/a.js'));
  assert.ok(globToRegExp('**/a.js').test('a.js'));
  assert.ok(globToRegExp('**/a.js').test('x/y/a.js'));
  assert.ok(globToRegExp('a?c').test('abc'));
  assert.ok(!globToRegExp('a?c').test('a/c'));
  assert.ok(globToRegExp('a.b').test('a.b'));
  assert.ok(!globToRegExp('a.b').test('axb'));
});

test('makeIgnore matches nested paths under an ignored directory', () => {
  const ignored = makeIgnore(['cache']);
  assert.ok(ignored('cache/x/y.txt'));
  assert.ok(ignored('a/cache/y.txt'));
  assert.ok(!ignored('a/cached/y.txt'));
  assert.ok(!makeIgnore([])('anything'));
});

test('diffManifests classifies every path', () => {
  const entry = (hash) => ({ hash, size: 1 });
  const local = { a: entry('1'), b: entry('2'), c: entry('3') };
  const remote = { b: entry('2'), c: entry('x'), d: entry('4') };
  assert.deepEqual(diffManifests(local, remote), {
    add: ['a'],
    update: ['c'],
    remove: ['d'],
    same: ['b']
  });
});

test('summarise only lists removals when pruning', () => {
  const plan = { add: ['a'], update: ['b'], remove: ['c'], same: [] };
  assert.deepEqual(summarise(plan), ['+ a', '~ b']);
  assert.deepEqual(summarise(plan, { prune: true }), ['+ a', '~ b', '- c']);
});
