// adapters/mysql.js
// Introspects a MySQL/MariaDB database using information_schema views.
// MySQL doesn't expose enum values as a separate catalog (unlike Postgres) -
// they're embedded in COLUMN_TYPE as enum('a','b','c'), so we regex them out.

async function introspectMySQL(connectionConfig, databaseName) {
  const mysql = require('mysql2/promise');
  const conn = await mysql.createConnection(connectionConfig);

  try {
    const dbName = databaseName || connectionConfig.database;
    if (!dbName) throw new Error('A database name is required for MySQL introspection.');

    const [colsRows] = await conn.execute(
      `SELECT
         table_name AS tableName,
         column_name AS columnName,
         data_type AS dataType,
         column_type AS columnType,
         character_maximum_length AS charMaxLen,
         numeric_precision AS numericPrecision,
         numeric_scale AS numericScale,
         is_nullable AS isNullable,
         column_default AS columnDefault,
         ordinal_position AS ordinalPosition,
         extra AS extra
       FROM information_schema.columns
       WHERE table_schema = ?
       ORDER BY table_name, ordinal_position`,
      [dbName]
    );

    const [pkRows] = await conn.execute(
      `SELECT table_name AS tableName, column_name AS columnName
       FROM information_schema.key_column_usage
       WHERE table_schema = ? AND constraint_name = 'PRIMARY'`,
      [dbName]
    );

    const [fkRows] = await conn.execute(
      `SELECT
         table_name AS tableName,
         column_name AS columnName,
         referenced_table_name AS refTable,
         referenced_column_name AS refColumn
       FROM information_schema.key_column_usage
       WHERE table_schema = ? AND referenced_table_name IS NOT NULL`,
      [dbName]
    );

    const [uniqueRows] = await conn.execute(
      `SELECT
         tc.table_name AS tableName,
         kcu.column_name AS columnName,
         tc.constraint_name AS constraintName
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema AND tc.table_name = kcu.table_name
       WHERE tc.constraint_type = 'UNIQUE' AND tc.table_schema = ?`,
      [dbName]
    );

    const rawColumns = colsRows.map(row => {
      let enumValues = null;
      let displayWidth = null;
      if (row.dataType === 'enum' || row.dataType === 'set') {
        const match = String(row.columnType).match(/\(([^)]+)\)/);
        if (match) {
          enumValues = match[1].split(',').map(s => s.trim().replace(/^'|'$/g, '').replace(/''/g, "'"));
        }
      } else if (row.dataType === 'tinyint' || row.dataType === 'int' || row.dataType === 'bigint' || row.dataType === 'smallint') {
        // capture display width e.g. tinyint(1) - this is NOT the same as numeric_precision,
        // and it's the only place MySQL records the tinyint(1)-means-boolean convention
        const match = String(row.columnType).match(/\((\d+)\)/);
        if (match) displayWidth = match[1];
      }
      return {
        tableName: row.tableName,
        columnName: row.columnName,
        dataType: row.dataType,
        charMaxLen: row.charMaxLen,
        numericPrecision: row.numericPrecision,
        numericScale: row.numericScale,
        isNullable: row.isNullable === 'YES',
        columnDefault: row.columnDefault,
        ordinalPosition: row.ordinalPosition,
        isAutoIncrement: String(row.extra || '').includes('auto_increment'),
        enumValues,
        displayWidth,
      };
    });

    const rawPrimaryKeys = pkRows.map(r => ({ tableName: r.tableName, columnName: r.columnName }));
    const rawForeignKeys = fkRows.map(r => ({
      tableName: r.tableName,
      columnName: r.columnName,
      refTable: r.refTable,
      refColumn: r.refColumn,
    }));
    const rawUniques = uniqueRows.map(r => ({
      tableName: r.tableName,
      columnName: r.columnName,
      constraintName: r.constraintName,
    }));

    return { rawColumns, rawPrimaryKeys, rawForeignKeys, rawUniques };
  } finally {
    await conn.end();
  }
}

module.exports = { introspectMySQL };
