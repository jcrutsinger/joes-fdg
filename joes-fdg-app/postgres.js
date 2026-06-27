// adapters/postgres.js
// Introspects a Postgres database/schema using information_schema views,
// plus pg_catalog for enum type values (information_schema has no enum support).

async function introspectPostgres(connectionConfig, schemaName) {
  const { Client } = require('pg');
  const client = new Client(connectionConfig);
  await client.connect();

  try {
    const schema = schemaName || 'public';

    // --- columns ---
    const colsResult = await client.query(
      `SELECT
         table_name,
         column_name,
         data_type,
         udt_name,
         character_maximum_length,
         numeric_precision,
         numeric_scale,
         is_nullable,
         column_default,
         ordinal_position
       FROM information_schema.columns
       WHERE table_schema = $1
       ORDER BY table_name, ordinal_position`,
      [schema]
    );

    // --- enum values, keyed by udt_name (the enum type name) ---
    const enumResult = await client.query(
      `SELECT t.typname AS udt_name, e.enumlabel
       FROM pg_type t
       JOIN pg_enum e ON e.enumtypid = t.oid
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = $1 OR n.nspname = 'public'
       ORDER BY t.typname, e.enumsortorder`,
      [schema]
    );
    const enumsByType = {};
    for (const row of enumResult.rows) {
      (enumsByType[row.udt_name] = enumsByType[row.udt_name] || []).push(row.enumlabel);
    }

    // --- primary keys ---
    const pkResult = await client.query(
      `SELECT tc.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1`,
      [schema]
    );

    // --- foreign keys ---
    const fkResult = await client.query(
      `SELECT
         tc.table_name,
         kcu.column_name,
         ccu.table_name AS ref_table,
         ccu.column_name AS ref_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1`,
      [schema]
    );

    // --- unique constraints (single + composite; frontend only uses single-column ones) ---
    const uniqueResult = await client.query(
      `SELECT tc.table_name, kcu.column_name, tc.constraint_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'UNIQUE' AND tc.table_schema = $1`,
      [schema]
    );

    // --- auto-increment / identity / serial detection ---
    const seqResult = await client.query(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = $1
         AND (column_default LIKE 'nextval(%' OR is_identity = 'YES')`,
      [schema]
    );
    const autoIncSet = new Set(seqResult.rows.map(r => `${r.table_name}.${r.column_name}`));

    const rawColumns = colsResult.rows.map(row => ({
      tableName: row.table_name,
      columnName: row.column_name,
      dataType: row.udt_name || row.data_type, // udt_name gives the real pg type name (e.g. 'varchar', enum type name)
      charMaxLen: row.character_maximum_length,
      numericPrecision: row.numeric_precision,
      numericScale: row.numeric_scale,
      isNullable: row.is_nullable === 'YES',
      columnDefault: row.column_default,
      ordinalPosition: row.ordinal_position,
      isAutoIncrement: autoIncSet.has(`${row.table_name}.${row.column_name}`),
      enumValues: enumsByType[row.udt_name] || null,
    }));

    const rawPrimaryKeys = pkResult.rows.map(r => ({ tableName: r.table_name, columnName: r.column_name }));
    const rawForeignKeys = fkResult.rows.map(r => ({
      tableName: r.table_name,
      columnName: r.column_name,
      refTable: r.ref_table,
      refColumn: r.ref_column,
    }));
    const rawUniques = uniqueResult.rows.map(r => ({
      tableName: r.table_name,
      columnName: r.column_name,
      constraintName: r.constraint_name,
    }));

    return { rawColumns, rawPrimaryKeys, rawForeignKeys, rawUniques };
  } finally {
    await client.end();
  }
}

module.exports = { introspectPostgres };
