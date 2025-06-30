import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

export function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function globToRegExp(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        i += 1;
        if (pattern[i + 1] === '/') {
          i += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

export function makeIgnore(patterns = []) {
  const matchers = patterns.map((raw) => {
    const anchored = raw.startsWith('/');
    const body = anchored ? raw.slice(1) : raw;
    const trimmed = body.endsWith('/') ? body.slice(0, -1) : body;
    const direct = globToRegExp(trimmed);
    const anywhere = anchored || trimmed.includes('/') ? null : globToRegExp(`**/${trimmed}`);
    return (path) => {
      const parts = path.split('/');
      for (let i = 1; i <= parts.length; i += 1) {
        const prefix = parts.slice(0, i).join('/');
        if (direct.test(prefix) || (anywhere && anywhere.test(prefix))) return true;
      }
      return false;
    };
  });
  return (path) => matchers.some((match) => match(path));
}

export async function scan(root, { ignore = [] } = {}) {
  const isIgnored = makeIgnore(ignore);
  const manifest = {};

  async function walk(relative) {
    const entries = await readdir(join(root, relative), { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (isIgnored(path)) continue;
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        const full = join(root, path);
        const info = await stat(full);
        manifest[path] = { hash: await hashFile(full), size: info.size };
      }
    }
  }

  await walk('');
  return manifest;
}
