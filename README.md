<div align="center">

# ferry

A small command line tool that syncs a directory to another machine over HTTP, sending only the files whose contents have changed. Server and client live in one package with no dependencies.

![License](https://img.shields.io/badge/LICENSE-MIT-blue?style=for-the-badge)  ![Language](https://img.shields.io/badge/JAVASCRIPT-f7df1e?style=for-the-badge&logo=javascript&logoColor=white)  ![Tests](https://img.shields.io/badge/TESTS-37-brightgreen?style=for-the-badge)

Refer to [LICENSE](LICENSE) for the legal bits.

</div>

## What's in it

- **Hash-based diffing.** The client scans a directory, compares SHA-256 hashes with the server's manifest and uploads only what is new or different. Touching a file without changing it costs nothing.
- **Safe uploads.** The server checks each body against the hash the client declared, writes to a temporary file and renames it into place, so a dropped connection never leaves half a file. Uploads can be size limited.
- **Pruning.** `--delete` removes files on the server that no longer exist locally and tidies up empty directories.
- **Ignore patterns.** `*.log`, `node_modules/` and `/build` style patterns, on both sides.
- **Auth and path safety.** An optional bearer token, compared in constant time. Traversal, absolute and backslash paths are refused, so a client can't write outside the served directory.
- **Parallel transfers** with a configurable concurrency.

```js
import { createFerryServer, push } from 'ferry';

const server = createFerryServer({ root: './site', token: 'hunter2' });
const { port } = await server.listen(8787);
const result = await push({ source: './local', server: `http://127.0.0.1:${port}`, token: 'hunter2', prune: true });
```

## 🏗️ Architecture

```
  ferry push ./site http://host:8787
 ┌────────────────────┐   GET /manifest          ┌─────────────────────┐
 │ client.js          │ ───────────────────────► │ server.js           │
 │  scan(source)      │ ◄─────────────────────── │  scan(root)         │
 │  diffManifests()   │   PUT /files/<path>      │  verify hash        │
 │  upload / delete   │ ───────────────────────► │  write .part        │
 └────────────────────┘   DELETE /files/<path>   │  rename into place  │
                                                 └─────────────────────┘
```

- `src/manifest.js` walks a directory, hashes files by streaming them, and holds the ignore pattern matcher.
- `src/diff.js` is a pure function that sorts paths into add, update, remove and same.
- `src/paths.js` validates relative paths and resolves them safely inside a root.
- `src/server.js` is the HTTP server on `node:http`: `GET /manifest`, `PUT /files/<path>` and `DELETE /files/<path>`.
- `src/client.js` fetches the remote manifest, plans the sync and runs uploads and deletes with bounded concurrency.
- `src/cli.js` and `bin/ferry.js` are the `serve`, `push` and `diff` commands.

## 🚀 Quick start

Needs Node 18 or newer. Nothing to install.

```
npm test
node bin/ferry.js serve ./site --port 8787 --token hunter2
node bin/ferry.js diff ./local http://localhost:8787 --token hunter2
node bin/ferry.js push ./local http://localhost:8787 --token hunter2 --delete --ignore "*.log"
```

The token can also come from `FERRY_TOKEN`. Pushing a small site with a `debug.log` ignored looks like this:

```
$ ferry diff ./local http://127.0.0.1:8799 --ignore "*.log"
+ css/site.css
+ index.html
would sync: 2 added, 0 updated, 0 removed, 0 unchanged (5 bytes)
$ ferry push ./local http://127.0.0.1:8799 --ignore "*.log"
+ index.html
+ css/site.css
synced: 2 added, 0 updated, 0 removed, 0 unchanged (5 bytes)
$ ferry push ./local http://127.0.0.1:8799 --ignore "*.log"
synced: 0 added, 0 updated, 0 removed, 2 unchanged (0 bytes)
```

The server speaks plain HTTP, so put it behind TLS or a private network if the data matters.

## 🧪 Testing

37 tests, all passing. They start real servers on random local ports:

- Sync (17): fresh push, no-op second push, only changed files sent, prune on and off, dry runs, ignore patterns, binary and oddly named files, empty files, token auth, hash mismatch, missing hash, traversal, size limit, temp file cleanup, 404s, unreachable server, parallel uploads.
- CLI (9): argument parsing, usage and help, unknown commands, missing directory, push, diff and delete end to end, rejected token, `serve` lifecycle.
- Manifests and diffing (7): scanning, ignore patterns, anchored patterns, glob conversion, plan classification, summaries.
- Paths (4): safe paths, unsafe paths, containment, encode and decode round trip.
