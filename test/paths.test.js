import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { safeRelative, resolveInside, PathError } from '../src/index.js';
import { decodePath, encodePath } from '../src/paths.js';

test('safeRelative accepts ordinary nested paths', () => {
  assert.equal(safeRelative('a/b/c.txt'), 'a/b/c.txt');
});

test('safeRelative rejects traversal, absolute and odd paths', () => {
  for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a//b', './a', 'a\\b', 'a\0b', 'a/']) {
    assert.throws(() => safeRelative(bad), PathError, JSON.stringify(bad));
  }
});

test('resolveInside stays beneath the root', () => {
  const root = resolve('some-root');
  assert.equal(resolveInside(root, 'x/y.txt'), join(root, 'x', 'y.txt'));
  assert.throws(() => resolveInside(root, '../escape'), PathError);
});

test('encodePath and decodePath round trip awkward names', () => {
  const path = 'my dir/f#le?.txt';
  assert.equal(decodePath(encodePath(path)), path);
  assert.ok(!encodePath(path).includes(' '));
  assert.ok(encodePath(path).includes('/'));
});
