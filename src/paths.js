import { resolve, sep } from 'node:path';

export class PathError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PathError';
  }
}

export function safeRelative(path) {
  if (typeof path !== 'string' || path === '') throw new PathError('empty path');
  if (path.includes('\0') || path.includes('\\')) throw new PathError(`bad characters in path "${path}"`);
  if (path.startsWith('/')) throw new PathError(`absolute path "${path}"`);
  const parts = path.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new PathError(`unsafe path "${path}"`);
  }
  return parts.join('/');
}

export function resolveInside(root, path) {
  const clean = safeRelative(path);
  const base = resolve(root);
  const full = resolve(base, ...clean.split('/'));
  if (full !== base && !full.startsWith(base + sep)) throw new PathError(`path escapes root "${path}"`);
  return full;
}

export function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

export function decodePath(encoded) {
  return encoded.split('/').map(decodeURIComponent).join('/');
}

