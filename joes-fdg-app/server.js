// server.js
//
// Local-only schema introspection service.
//
// SECURITY NOTE: this server will connect to whatever database the caller
// tells it to connect to, using whatever credentials the caller provides.
// That is exactly what makes it useful (a generic "introspect any DB I have
// access to" tool) and exactly what makes it dangerous to expose on the
// open internet - anyone who can reach this server can use it to probe or
// read schema metadata from any database THEY can reach (including internal
// network addresses), using credentials THEY supply. There is no auth layer.
//
// This is built to run on your own machine, talking to databases you already
// have legitimate access to, with the frontend open in the same browser.
// Do not deploy this to a public host without adding authentication and
// network egress restrictions.

const express = require('express');
const cors = require('cors');
const { buildSchema } = require('./schema-builder.js');

const app = express();
app.use(express.json({ limit: '1mb' }));

// CORS: allow the static frontend (served from file:// or any localhost port)
// to call this API. Restrict to localhost origins only - this is not meant
// to be a public API.
app.use(cors({
  origin: (origin, callback) => {
    // file:// pages send Origin: null: allow it, since that's how the static
    // HTML tool will be opened during normal local use.
    if (!origin || origin === 'null' || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    callback(new Error('Origin not allowed'));
  },
}));

const PORT = process.env.PORT || 4848;
const HOST = process.env.HOST || '127.0.0.1'; // localhost-only by default, intentionally

app.get('/health', (req, res) => {
  res.json({ ok: true, engines: ['postgres', 'mysql', 'sqlite'] });
});

/**
 * POST /schema
 * body: {
 *   engine: 'postgres' | 'mysql' | 'sqlite',
 *   // for postgres/mysql:
 *   host, port, user, password, database, schema?, ssl?,
 *   // for sqlite:
 *   filePath
 * }
 *
 * Returns: { tables: {...}, order: [...] }  - same shape as the frontend's
 * parseSchema() output, ready to feed straight into generateData().
 */
app.post('/schema', async (req, res) => {
  const body = req.body || {};
  const engine = body.engine;

  if (!engine || !['postgres', 'mysql', 'sqlite'].includes(engine)) {
    return res.status(400).json({ error: "Missing or invalid 'engine'. Must be 'postgres', 'mysql', or 'sqlite'." });
  }

  try {
    let raw;

    if (engine === 'postgres') {
      const { introspectPostgres } = require('./adapters/postgres.js');
      const required = ['host', 'user', 'database'];
      const missing = required.filter(k => !body[k]);
      if (missing.length) return res.status(400).json({ error: `Missing required field(s): ${missing.join(', ')}` });

      raw = await introspectPostgres({
        host: body.host,
        port: body.port || 5432,
        user: body.user,
        password: body.password || '',
        database: body.database,
        ssl: body.ssl ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: 8000,
      }, body.pgSchema || 'public');

    } else if (engine === 'mysql') {
      const { introspectMySQL } = require('./adapters/mysql.js');
      const required = ['host', 'user', 'database'];
      const missing = required.filter(k => !body[k]);
      if (missing.length) return res.status(400).json({ error: `Missing required field(s): ${missing.join(', ')}` });

      raw = await introspectMySQL({
        host: body.host,
        port: body.port || 3306,
        user: body.user,
        password: body.password || '',
        database: body.database,
        connectTimeout: 8000,
      }, body.database);

    } else if (engine === 'sqlite') {
      const { introspectSQLite } = require('./adapters/sqlite.js');
      if (!body.filePath) return res.status(400).json({ error: "Missing required field: 'filePath'" });

      raw = await introspectSQLite(body.filePath);
    }

    const schema = buildSchema(raw.rawColumns, raw.rawPrimaryKeys, raw.rawForeignKeys, raw.rawUniques);

    if (Object.keys(schema.tables).length === 0) {
      return res.status(404).json({ error: 'Connected successfully, but no tables were found in that database/schema.' });
    }

    res.json(schema);
  } catch (err) {
    // Surface a clean message - connection errors from pg/mysql2 drivers are
    // usually informative on their own (auth failed, host unreachable, etc.)
    res.status(502).json({ error: err.message || 'Failed to introspect database.' });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Schema introspection server running at http://${HOST}:${PORT}`);
  console.log('This server is intended for local use only. Do not expose it publicly.');
});

module.exports = app;
