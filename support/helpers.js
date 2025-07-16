import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export async function makeTree(files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ferry-'));
  await writeTree(dir, files);
  return dir;
}

export async function writeTree(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, ...path.split('/'));
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
}

export async function readText(dir, path) {
  return readFile(join(dir, ...path.split('/')), 'utf8');
}

export async function cleanup(...dirs) {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
}

export function collector() {
  const chunks = [];
  return { write: (text) => chunks.push(text), text: () => chunks.join('') };
}
