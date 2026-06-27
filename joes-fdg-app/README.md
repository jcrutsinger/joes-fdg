# Schema Introspector — local backend

A small Express server that connects to a real Postgres, MySQL, or SQLite
database, reads its schema metadata, and returns it as JSON in the exact
shape the fake-data-generator frontend already expects from
`parseSchema()`. Point the frontend at this instead of pasting SQL by hand.

## Setup

```bash
cd backend
npm install
npm start
```

Starts on `http://127.0.0.1:4848` by default. Override with `PORT` and `HOST`
env vars if needed.

SQLite support uses Node’s built-in `node:sqlite` module (stable on Node
22.5+; experimental on earlier 22.x with a console warning, which is
harmless). If you’re on an older Node version where `node:sqlite` doesn’t
exist at all, install `better-sqlite3` as a fallback:

```bash
npm install better-sqlite3
```

## ⚠️ Security — read this before running anywhere but your own machine

This server connects to **whatever database it’s told to connect to**,
using **whatever credentials are sent in the request body**. There is no
authentication on the server itself, and no allowlist of permitted hosts.

That’s what makes it useful — a generic “introspect any DB I have access
to” tool — and also exactly what makes it unsafe to expose publicly:
anyone who can reach this server can use it to probe schema metadata on
any host it can reach (including internal/private network addresses),
using credentials they supply. This is the same class of risk as SSRF.

Mitigations built in:

- Binds to `127.0.0.1` by default — not reachable from other machines on
  your network unless you explicitly change `HOST`.
- CORS only allows `localhost`/`127.0.0.1` origins (plus `null`, which is
  what browsers send for `file://` pages — needed so the static HTML tool
  can call this when opened directly as a file).
- Credentials are never written to disk or logged. Each request opens a
  connection, runs read-only introspection queries, and closes it.
- All queries are parameterized except SQLite `PRAGMA` calls, which can’t
  be parameterized by the SQLite engine itself — table names there come
  from `sqlite_master` (already-trusted DB metadata), not from the request
  body, so this isn’t a SQL-injection path.

What this does **not** do, and would need to before any public/shared
deployment: rate limiting, authentication, an allowlist of permitted hosts,
audit logging, or query timeouts beyond the connection-level ones already
set. Don’t put this on a public URL as-is.

## API

### `GET /health`

Returns `{ ok: true, engines: [...] }`. Use this to confirm the server is up.

### `POST /schema`

**Postgres / MySQL body:**

```json
{
  "engine": "postgres",
  "host": "localhost",
  "port": 5432,
  "user": "myuser",
  "password": "mypassword",
  "database": "mydb",
  "pgSchema": "public",
  "ssl": false
}
```

(`pgSchema` is Postgres-only and defaults to `"public"`. MySQL has no
separate schema concept — `database` doubles as both connection target and
introspection scope.)

**SQLite body:**

```json
{
  "engine": "sqlite",
  "filePath": "/absolute/path/to/your.db"
}
```

**Response (success, 200):** the canonical schema object —

```json
{
  "tables": {
    "customers": {
      "name": "customers",
      "columns": [ { "name": "id", "rawType": "...", "isPK": true, "category": {...}, ... } ],
      "primaryKey": ["id"],
      "foreignKeys": [...],
      "uniques": [...]
    }
  },
  "order": ["customers", "orders", "..."]
}
```

This is a drop-in replacement for what the frontend’s `parseSchema(sqlText)`
returns — feed it straight into `generateData(schema, rowCounts, seed)`.

**Response (error):** `400` for missing/invalid request fields, `404` if
the connection succeeds but no tables are found, `502` for connection or
driver errors (bad credentials, unreachable host, etc.) — the underlying
driver’s error message is passed through since `pg`/`mysql2` errors are
normally clear on their own (e.g. `password authentication failed for user "..."`).

## Known limitation shared with the SQL-text parser

Column semantic detection (email, money, names, etc.) is based on the
column’s **name**, combined with its declared type. SQLite stores most
columns as loosely-typed `TEXT`/`INTEGER`/`REAL` regardless of what was
declared, so a column like `created_at TEXT` won’t be recognized as a
date — there’s no type signal to go on, only the name, and the current
logic for datetime columns checks declared type before falling through to
name-based string heuristics. Postgres and MySQL don’t have this issue
since their `information_schema` reports the real declared type.

## Files

- `server.js` — Express app, route handling, CORS/host binding
- `schema-builder.js` — engine-agnostic core: turns normalized introspection
  rows into the canonical schema shape (same `classifyType` logic as the
  frontend’s `engine.js`)
- `adapters/postgres.js` — `information_schema` + `pg_enum` queries via `pg`
- `adapters/mysql.js` — `information_schema` queries via `mysql2`, enum
  values parsed out of `COLUMN_TYPE`
- `adapters/sqlite.js` — `PRAGMA table_info` / `foreign_key_list` /
  `index_list` via `node:sqlite` (or `better-sqlite3` fallback)