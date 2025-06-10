import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { diffManifests } from './diff.js';
import { scan } from './manifest.js';
import { encodePath } from './paths.js';

export class SyncError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'SyncError';
    this.status = status;
  }
}

function endpoint(server) {
  return server.replace(/\/+$/, '');
}

async function check(response, action) {
  if (response.ok) return response;
  const text = await response.text().catch(() => '');
  throw new SyncError(`${action} failed with ${response.status}${text ? `: ${text}` : ''}`, response.status);
}

async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function fetchRemoteManifest(server, token) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const response = await fetch(`${endpoint(server)}/manifest`, { headers }).catch((error) => {
    throw new SyncError(`could not reach ${server}: ${error.cause?.code ?? error.message}`);
  });
  await check(response, 'fetching manifest');
  return response.json();
}

export async function push({ source, server, token = null, ignore = [], prune = false, dryRun = false, concurrency = 4, onEvent = () => {} }) {
  const local = await scan(source, { ignore });
  const remote = await fetchRemoteManifest(server, token);
  const plan = diffManifests(local, remote);
  const uploads = [...plan.add, ...plan.update];
  const removals = prune ? plan.remove : [];
  const result = {
    added: plan.add.length,
    updated: plan.update.length,
    removed: removals.length,
    unchanged: plan.same.length,
    bytes: uploads.reduce((sum, path) => sum + local[path].size, 0),
    dryRun
  };
  if (dryRun) return { ...result, plan };

  const headers = token ? { authorization: `Bearer ${token}` } : {};
  await mapLimit(uploads, concurrency, async (path) => {
    const body = await readFile(join(source, ...path.split('/')));
    const response = await fetch(`${endpoint(server)}/files/${encodePath(path)}`, {
      method: 'PUT',
      headers: { ...headers, 'x-ferry-hash': local[path].hash, 'content-type': 'application/octet-stream' },
      body
    });
    await check(response, `uploading ${path}`);
    onEvent({ type: remote[path] ? 'update' : 'add', path });
  });
  await mapLimit(removals, concurrency, async (path) => {
    const response = await fetch(`${endpoint(server)}/files/${encodePath(path)}`, { method: 'DELETE', headers });
    await check(response, `removing ${path}`);
    onEvent({ type: 'remove', path });
  });
  return { ...result, plan };
}
