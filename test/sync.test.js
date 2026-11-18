import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createFerryServer, push, scan, SyncError, fetchRemoteManifest, hashBuffer } from '../src/index.js';
import { cleanup, makeTree, readText, writeTree } from '../support/helpers.js';

let source;
let target;
let ferry;
let url;

async function start(options = {}) {
  ferry = createFerryServer({ root: target, ...options });
  const address = await ferry.listen(0);
  url = `http://127.0.0.1:${address.port}`;
}

beforeEach(async () => {
  source = await makeTree({ 'a.txt': 'alpha', 'dir/b.txt': 'bravo' });
  target = await makeTree({});
});

afterEach(async () => {
  await ferry?.close();
  ferry = null;
  await cleanup(source, target);
});

test('pushes a fresh tree', async () => {
  await start();
  const result = await push({ source, server: url });
  assert.equal(result.added, 2);
  assert.equal(result.updated, 0);
  assert.equal(await readText(target, 'dir/b.txt'), 'bravo');
  assert.deepEqual(await scan(target), await scan(source));
});

test('a second push transfers nothing', async () => {
  await start();
  await push({ source, server: url });
  const events = [];
  const again = await push({ source, server: url, onEvent: (e) => events.push(e) });
  assert.equal(again.added + again.updated + again.removed, 0);
  assert.equal(again.unchanged, 2);
  assert.deepEqual(events, []);
});

test('only changed files are sent', async () => {
  await start();
  await push({ source, server: url });
  await writeTree(source, { 'a.txt': 'alpha two', 'c.txt': 'charlie' });
  const events = [];
  const result = await push({ source, server: url, onEvent: (e) => events.push(`${e.type}:${e.path}`) });
  assert.equal(result.updated, 1);
  assert.equal(result.added, 1);
  assert.deepEqual(events.sort(), ['add:c.txt', 'update:a.txt']);
  assert.equal(await readText(target, 'a.txt'), 'alpha two');
});

test('extra files on the server survive unless delete is requested', async () => {
  await writeTree(target, { 'stale/old.txt': 'old' });
  await start();
  const kept = await push({ source, server: url });
  assert.equal(kept.removed, 0);
  assert.equal(await readText(target, 'stale/old.txt'), 'old');
  const pruned = await push({ source, server: url, prune: true });
  assert.equal(pruned.removed, 1);
  await assert.rejects(() => access(join(target, 'stale', 'old.txt')));
  await assert.rejects(() => access(join(target, 'stale')));
});

test('dry runs change nothing', async () => {
  await start();
  const result = await push({ source, server: url, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.plan.add, ['a.txt', 'dir/b.txt']);
  assert.deepEqual(await scan(target), {});
});

test('ignored files are not sent', async () => {
  await writeTree(source, { 'x.log': 'noise' });
  await start();
  await push({ source, server: url, ignore: ['*.log'] });
  assert.deepEqual(Object.keys(await scan(target)), ['a.txt', 'dir/b.txt']);
});

test('binary content and odd file names survive', async () => {
  const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 256));
  await mkdir(join(source, 'my dir'), { recursive: true });
  await writeFile(join(source, 'my dir', 'f#le.bin'), bytes);
  await start();
  await push({ source, server: url });
  const copied = await readFile(join(target, 'my dir', 'f#le.bin'));
  assert.ok(copied.equals(bytes));
});

test('empty files are synced', async () => {
  await writeTree(source, { 'empty.txt': '' });
  await start();
  await push({ source, server: url });
  assert.equal(await readText(target, 'empty.txt'), '');
});

test('a token is required when the server has one', async () => {
  await start({ token: 'secret' });
  await assert.rejects(() => push({ source, server: url }), (err) => err instanceof SyncError && err.status === 401);
  await assert.rejects(() => push({ source, server: url, token: 'wrong' }), (err) => err.status === 401);
  const result = await push({ source, server: url, token: 'secret' });
  assert.equal(result.added, 2);
});

test('the server rejects uploads whose hash does not match', async () => {
  await start();
  const response = await fetch(`${url}/files/a.txt`, {
    method: 'PUT',
    headers: { 'x-ferry-hash': hashBuffer(Buffer.from('other')) },
    body: 'alpha'
  });
  assert.equal(response.status, 422);
  assert.deepEqual(await scan(target), {});
});

test('the server rejects missing hashes and path traversal', async () => {
  await start();
  const noHash = await fetch(`${url}/files/a.txt`, { method: 'PUT', body: 'x' });
  assert.equal(noHash.status, 400);
  const hash = hashBuffer(Buffer.from('x'));
  const escape = await fetch(`${url}/files/a%2F..%2F..%2Fevil.txt`, { method: 'PUT', headers: { 'x-ferry-hash': hash }, body: 'x' });
  assert.equal(escape.status, 400);
  const slashes = await fetch(`${url}/files/a%5Cb.txt`, { method: 'PUT', headers: { 'x-ferry-hash': hash }, body: 'x' });
  assert.equal(slashes.status, 400);
});

test('the server enforces a size limit', async () => {
  await start({ maxBytes: 10 });
  const body = 'x'.repeat(100);
  const response = await fetch(`${url}/files/big.txt`, {
    method: 'PUT',
    headers: { 'x-ferry-hash': hashBuffer(Buffer.from(body)) },
    body
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await scan(target), {});
});

test('the server cleans up temporary files after a failed upload', async () => {
  await start();
  await fetch(`${url}/files/a.txt`, { method: 'PUT', headers: { 'x-ferry-hash': 'f'.repeat(64) }, body: 'alpha' });
  assert.deepEqual(await scan(target), {});
});

test('deleting a missing file is a 404 and unknown routes are 404', async () => {
  await start();
  assert.equal((await fetch(`${url}/files/nope.txt`, { method: 'DELETE' })).status, 404);
  assert.equal((await fetch(`${url}/elsewhere`)).status, 404);
});

test('the server manifest hides ignored files', async () => {
  await writeTree(target, { 'keep.txt': '1', 'secret.env': '2' });
  await start({ ignore: ['*.env'] });
  assert.deepEqual(Object.keys(await fetchRemoteManifest(url, null)), ['keep.txt']);
});

test('an unreachable server gives a readable error', async () => {
  await start();
  const dead = url;
  await ferry.close();
  ferry = null;
  await assert.rejects(() => push({ source, server: dead }), (err) => err instanceof SyncError && /could not reach/.test(err.message));
});

test('uploads in parallel produce the same result as one at a time', async () => {
  const files = {};
  for (let i = 0; i < 25; i += 1) files[`bulk/f${i}.txt`] = `content ${i}`;
  await writeTree(source, files);
  await start();
  await push({ source, server: url, concurrency: 8 });
  assert.deepEqual(await scan(target), await scan(source));
});

