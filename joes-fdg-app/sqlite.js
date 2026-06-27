// adapters/sqlite.js
// Introspects a SQLite database file using PRAGMA statements.
// Uses Node's built-in node:sqlite (stable from Node 22.5+, experimental before).
// Falls back to better-sqlite3 if node:sqlite isn't available (e.g. older Node).

async function introspectSQLite(filePath) {
  let db;
  let driver;

  // Resolve which driver to use FIRST (require only, no DB operations yet),
  // so a later failure to open the actual file is never mistaken for "driver missing".
  let DatabaseSyncCtor = null;
  let BetterSqlite3Ctor = null;
  try {
    DatabaseSyncCtor = require('node:sqlite').DatabaseSync;
    driver = 'node:sqlite';
  } catch (e) {
    try {
      BetterSqlite3Ctor = require('better-sqlite3');
      driver = 'better-sqlite3';
    } catch (e2) {
      throw new Error('No SQLite driver available. Install with: npm install better-sqlite3');
    }
  }

  // Now actually open the file - any error here (missing file, permissions,
  // corrupt file) is a real, meaningful error and must propagate as-is.
  if (driver === 'node:sqlite') {
    db = new DatabaseSyncCtor(filePath, { readOnly: true });
  } else {
    db = new BetterSqlite3Ctor(filePath, { readonly: true, fileMustExist: true });
  }

  try {
    const query = (sql) => {
      if (driver === 'node:sqlite') {
        return db.prepare(sql).all();
      } else {
        return db.prepare(sql).all();
      }
    };

    const tableRows = query(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `);
    const tableNames = tableRows.map(r => r.name);

    const rawColumns = [];
    const rawPrimaryKeys = [];
    const rawForeignKeys = [];
    const rawUniques = [];

    for (const tableName of tableNames) {
      // PRAGMA calls can't be parameterized - tableName comes from sqlite_master, not user input, so safe to interpolate
      const safeTable = tableName.replace(/"/g, '""');
      const cols = query(`PRAGMA table_info("${safeTable}")`);
      for (const col of cols) {
        const typeMatch = String(col.type || '').match(/^([a-zA-Z ]+)(?:\((\d+)(?:,\s*(\d+))?\))?/);
        const dataType = (typeMatch ? typeMatch[1] : col.type || 'text').trim();
        const charMaxLen = typeMatch && typeMatch[2] && !typeMatch[3] ? parseInt(typeMatch[2], 10) : null;
        const numericPrecision = typeMatch && typeMatch[2] && typeMatch[3] ? parseInt(typeMatch[2], 10) : null;
        const numericScale = typeMatch && typeMatch[3] ? parseInt(typeMatch[3], 10) : null;

        rawColumns.push({
          tableName,
          columnName: col.name,
          dataType,
          charMaxLen,
          numericPrecision,
          numericScale,
          isNullable: col.notnull === 0,
          columnDefault: col.dflt_value,
          ordinalPosition: col.cid,
          isAutoIncrement: dataType.toLowerCase() === 'integer' && col.pk === 1, // SQLite INTEGER PRIMARY KEY is the rowid alias
        });

        if (col.pk > 0) {
          rawPrimaryKeys.push({ tableName, columnName: col.name });
        }
      }

      const fks = query(`PRAGMA foreign_key_list("${safeTable}")`);
      for (const fk of fks) {
        rawForeignKeys.push({
          tableName,
          columnName: fk.from,
          refTable: fk.table,
          refColumn: fk.to,
        });
      }

      const indexes = query(`PRAGMA index_list("${safeTable}")`);
      for (const idx of indexes) {
        if (idx.unique) {
          const idxCols = query(`PRAGMA index_info("${idx.name.replace(/"/g, '""')}")`);
          for (const ic of idxCols) {
            rawUniques.push({ tableName, columnName: ic.name, constraintName: idx.name });
          }
        }
      }
    }

    return { rawColumns, rawPrimaryKeys, rawForeignKeys, rawUniques };
  } finally {
    db.close();
  }
}

module.exports = { introspectSQLite };
