import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, parseArgs, UsageError, createFerryServer, scan } from '../src/index.js';
import { cleanup, collector, makeTree, readText } from '../support/helpers.js';

test('parseArgs separates positionals from flags', () => {
  const parsed = parseArgs(['push', 'src', 'http://x', '--token', 't', '--ignore=*.log', '--ignore', 'tmp', '--delete', '--dry-run']);
  assert.equal(parsed.command, 'push');
  assert.deepEqual(parsed.args, ['src', 'http://x']);
  assert.equal(parsed.flags.token, 't');
  assert.deepEqual(parsed.flags.ignore, ['*.log', 'tmp']);
  assert.equal(parsed.flags.delete, true);
  assert.equal(parsed.flags['dry-run'], true);
});

test('parseArgs rejects unknown options and missing values', () => {
  assert.throws(() => parseArgs(['--wat']), UsageError);
  assert.throws(() => parseArgs(['push', '--token']), UsageError);
});

test('no arguments prints usage and fails', async () => {
  const stdout = collector();
  const code = await run([], { stdout, stderr: collector(), env: {} });
  assert.equal(code, 1);
  assert.match(stdout.text(), /usage:/);
});

test('help exits cleanly', async () => {
  const stdout = collector();
  assert.equal(await run(['--help'], { stdout, stderr: collector(), env: {} }), 0);
});

test('unknown commands are usage errors', async () => {
  const stderr = collector();
  assert.equal(await run(['frobnicate'], { stdout: collector(), stderr, env: {} }), 2);
  assert.match(stderr.text(), /unknown command/);
});

test('push needs a real directory', async () => {
  const stderr = collector();
  const code = await run(['push', 'definitely-not-here', 'http://127.0.0.1:1'], { stdout: collector(), stderr, env: {} });
  assert.equal(code, 2);
  assert.match(stderr.text(), /not a directory/);
});

test('push, diff and delete through the CLI', async () => {
  const source = await makeTree({ 'one.txt': '1', 'two.txt': '2' });
  const target = await makeTree({ 'old.txt': 'x' });
  const ferry = createFerryServer({ root: target, token: 'tok' });
  const { port } = await ferry.listen(0);
  const url = `http://127.0.0.1:${port}`;
  try {
    const diffOut = collector();
    assert.equal(await run(['diff', source, url], { stdout: diffOut, stderr: collector(), env: { FERRY_TOKEN: 'tok' } }), 0);
    assert.match(diffOut.text(), /\+ one\.txt/);
    assert.match(diffOut.text(), /would sync: 2 added/);
    assert.deepEqual(Object.keys(await scan(target)), ['old.txt']);

    const pushOut = collector();
    assert.equal(await run(['push', source, url, '--delete'], { stdout: pushOut, stderr: collector(), env: { FERRY_TOKEN: 'tok' } }), 0);
    assert.match(pushOut.text(), /synced: 2 added, 0 updated, 1 removed/);
    assert.equal(await readText(target, 'two.txt'), '2');
    assert.deepEqual(Object.keys(await scan(target)), ['one.txt', 'two.txt']);
  } finally {
    await ferry.close();
    await cleanup(source, target);
  }
});

test('a rejected token exits with status 1', async () => {
  const source = await makeTree({ 'one.txt': '1' });
  const target = await makeTree({});
  const ferry = createFerryServer({ root: target, token: 'tok' });
  const { port } = await ferry.listen(0);
  try {
    const stderr = collector();
    const code = await run(['push', source, `http://127.0.0.1:${port}`, '--token', 'bad'], { stdout: collector(), stderr, env: {} });
    assert.equal(code, 1);
    assert.match(stderr.text(), /401/);
  } finally {
    await ferry.close();
    await cleanup(source, target);
  }
});

test('serve starts, reports its address and stops on abort', async () => {
  const dir = await makeTree({ 'x.txt': 'x' });
  const stdout = collector();
  const controller = new AbortController();
  const finished = run(['serve', dir, '--port', '0'], { stdout, stderr: collector(), env: {}, signal: controller.signal });
  try {
    for (let i = 0; i < 50 && !/serving/.test(stdout.text()); i += 1) await new Promise((r) => setTimeout(r, 20));
    const match = stdout.text().match(/http:\/\/127\.0\.0\.1:(\d+)/);
    assert.ok(match);
    const response = await fetch(`http://127.0.0.1:${match[1]}/manifest`);
    assert.deepEqual(Object.keys(await response.json()), ['x.txt']);
  } finally {
    controller.abort();
    assert.equal(await finished, 0);
    await cleanup(dir);
  }
});
