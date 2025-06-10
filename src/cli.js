import { stat } from 'node:fs/promises';
import { push, SyncError } from './client.js';
import { summarise } from './diff.js';
import { createFerryServer } from './server.js';

const USAGE = `usage:
  ferry serve <dir> [--port 8787] [--host 127.0.0.1] [--token secret] [--ignore pattern]
  ferry push <dir> <url> [--token secret] [--ignore pattern] [--delete] [--dry-run] [--concurrency 4]
  ferry diff <dir> <url> [--token secret] [--ignore pattern]

The token can also come from the FERRY_TOKEN environment variable.`;

const VALUE_FLAGS = new Set(['port', 'host', 'token', 'ignore', 'concurrency']);
const BOOLEAN_FLAGS = new Set(['delete', 'dry-run', 'help']);

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

export function parseArgs(argv) {
  const positional = [];
  const flags = { ignore: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [rawName, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (BOOLEAN_FLAGS.has(rawName)) {
      flags[rawName] = true;
    } else if (VALUE_FLAGS.has(rawName)) {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new UsageError(`--${rawName} needs a value`);
      if (rawName === 'ignore') flags.ignore.push(value);
      else flags[rawName] = value;
    } else {
      throw new UsageError(`unknown option --${rawName}`);
    }
  }
  const [command, ...rest] = positional;
  return { command, args: rest, flags };
}

function parseNumber(value, name, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new UsageError(`--${name} must be a whole number`);
  return number;
}

async function requireDirectory(path) {
  const info = await stat(path).catch(() => null);
  if (!info || !info.isDirectory()) throw new UsageError(`${path} is not a directory`);
}

export async function run(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env, signal } = {}) {
  const out = (text) => stdout.write(`${text}\n`);
  try {
    const { command, args, flags } = parseArgs(argv);
    if (flags.help || command === undefined || command === 'help') {
      out(USAGE);
      return command === undefined && !flags.help ? 1 : 0;
    }
    const token = flags.token ?? env.FERRY_TOKEN ?? null;

    if (command === 'serve') {
      if (args.length !== 1) throw new UsageError('serve needs exactly one directory');
      await requireDirectory(args[0]);
      const ferry = createFerryServer({ root: args[0], token, ignore: flags.ignore });
      const address = await ferry.listen(parseNumber(flags.port, 'port', 8787), flags.host ?? '127.0.0.1');
      out(`serving ${args[0]} on http://${address.address}:${address.port}`);
      await new Promise((resolve) => {
        if (signal) signal.addEventListener('abort', resolve, { once: true });
        else {
          process.once('SIGINT', resolve);
          process.once('SIGTERM', resolve);
        }
      });
      await ferry.close();
      return 0;
    }

    if (command === 'push' || command === 'diff') {
      if (args.length !== 2) throw new UsageError(`${command} needs a directory and a server url`);
      await requireDirectory(args[0]);
      const dryRun = command === 'diff' || flags['dry-run'] === true;
      const prune = flags.delete === true;
      const result = await push({
        source: args[0],
        server: args[1],
        token,
        ignore: flags.ignore,
        prune,
        dryRun,
        concurrency: Math.max(1, parseNumber(flags.concurrency, 'concurrency', 4)),
        onEvent: (event) => out(`${{ add: '+', update: '~', remove: '-' }[event.type]} ${event.path}`)
      });
      if (dryRun) for (const line of summarise(result.plan, { prune })) out(line);
      out(
        `${dryRun ? 'would sync' : 'synced'}: ${result.added} added, ${result.updated} updated, ` +
          `${result.removed} removed, ${result.unchanged} unchanged (${result.bytes} bytes)`
      );
      return 0;
    }

    throw new UsageError(`unknown command "${command}"`);
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`ferry: ${error.message}\n\n${USAGE}\n`);
      return 2;
    }
    if (error instanceof SyncError) {
      stderr.write(`ferry: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
