import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { scan } from './manifest.js';
import { PathError, decodePath, resolveInside } from './paths.js';

const FILE_PREFIX = '/files/';

function send(res, status, body) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
    'content-length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function tokensMatch(given, expected) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function receive(req, target, maxBytes) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const out = createWriteStream(target);
    let size = 0;
    let failed = false;
    const fail = (error) => {
      if (failed) return;
      failed = true;
      out.destroy();
      reject(error);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error('payload too large');
        error.status = 413;
        fail(error);
        return;
      }
      hash.update(chunk);
      if (!out.write(chunk)) {
        req.pause();
        out.once('drain', () => req.resume());
      }
    });
    req.on('error', fail);
    req.on('aborted', () => fail(new Error('request aborted')));
    out.on('error', fail);
    req.on('end', () => {
      if (failed) return;
      out.end(() => resolvePromise({ hash: hash.digest('hex'), size }));
    });
  });
}

async function pruneEmptyDirs(root, start) {
  const base = resolve(root);
  let dir = start;
  while (dir !== base && dir.startsWith(base)) {
    const entries = await readdir(dir);
    if (entries.length > 0) return;
    await rmdir(dir);
    dir = dirname(dir);
  }
}

export function createFerryServer({ root, token = null, maxBytes = 1024 * 1024 * 1024, ignore = [] }) {
  const base = resolve(root);

  async function handleUpload(req, res, path) {
    const target = resolveInside(base, path);
    const expected = req.headers['x-ferry-hash'];
    if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) {
      send(res, 400, 'missing or invalid x-ferry-hash');
      req.resume();
      return;
    }
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.ferry-${randomBytes(6).toString('hex')}.part`;
    try {
      const received = await receive(req, temp, maxBytes);
      if (received.hash !== expected) {
        await rm(temp, { force: true });
        send(res, 422, 'hash mismatch');
        return;
      }
      const existing = await stat(target).catch(() => null);
      if (existing && existing.isDirectory()) {
        await rm(temp, { force: true });
        send(res, 409, 'a directory exists at that path');
        return;
      }
      await rename(temp, target);
      send(res, 200, { path, size: received.size, hash: received.hash });
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  async function handleDelete(res, path) {
    const target = resolveInside(base, path);
    const info = await stat(target).catch(() => null);
    if (!info || !info.isFile()) {
      send(res, 404, 'not found');
      return;
    }
    await rm(target);
    await pruneEmptyDirs(base, dirname(target));
    send(res, 200, { path });
  }

  async function route(req, res) {
    if (token !== null) {
      const header = req.headers.authorization ?? '';
      const given = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!tokensMatch(given, token)) {
        send(res, 401, 'unauthorised');
        req.resume();
        return;
      }
    }
    const url = new URL(req.url, 'http://ferry.local');
    if (req.method === 'GET' && url.pathname === '/manifest') {
      send(res, 200, await scan(base, { ignore }));
      return;
    }
    if (url.pathname.startsWith(FILE_PREFIX)) {
      const path = decodePath(url.pathname.slice(FILE_PREFIX.length));
      if (req.method === 'PUT') return handleUpload(req, res, path);
      if (req.method === 'DELETE') return handleDelete(res, path);
    }
    send(res, 404, 'not found');
    req.resume();
  }

  const server = createServer((req, res) => {
    route(req, res).catch((error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof PathError || error instanceof URIError) send(res, 400, error.message);
      else send(res, error.status ?? 500, error.status ? error.message : 'internal error');
    });
  });

  return {
    server,
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolvePromise, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolvePromise(server.address());
        });
      });
    },
    close() {
      return new Promise((resolvePromise) => {
        server.close(() => resolvePromise());
        server.closeAllConnections?.();
      });
    }
  };
}

