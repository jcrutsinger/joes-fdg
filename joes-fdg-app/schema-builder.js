// schema-builder.js
// Converts normalized introspection rows into the same { tables, order } shape
// that the frontend's parseSchema() produces from raw SQL text.
// Keeping this 1:1 with engine.js's classifyType means the generator
// downstream behaves identically whether the schema came from pasted SQL
// or a live DB connection.

// ---- classifyType: copied verbatim from the frontend engine.js so semantic
// detection (email, money, firstName, etc.) is identical across both paths ----

function classifyType(rawType, typeArgs, colName) {
  const t = String(rawType).toLowerCase();
  const n = String(colName).toLowerCase();

  if (/^(serial|bigserial|smallserial)$/.test(t)) return { kind: 'integer', semantic: 'id' };
  if (t === 'tinyint' && typeArgs[0] === '1') return { kind: 'boolean' }; // MySQL convention: tinyint(1) is a boolean
  if (/^(int|integer|bigint|smallint|tinyint|mediumint|int2|int4|int8)$/.test(t)) {
    if (/^id$|_id$/.test(n)) return { kind: 'integer', semantic: 'id' };
    if (/age$/.test(n)) return { kind: 'integer', semantic: 'age' };
    if (/qty|quantity|count|stock|inventory/.test(n)) return { kind: 'integer', semantic: 'quantity' };
    if (/year$/.test(n)) return { kind: 'integer', semantic: 'year' };
    if (/rating|stars?$|score/.test(n)) return { kind: 'integer', semantic: 'rating' };
    return { kind: 'integer', semantic: 'generic' };
  }
  if (/^(decimal|numeric|float|double|real|money|float4|float8|double precision)/.test(t)) {
    if (/price|cost|amount|total|balance|salary|fee|revenue/.test(n)) return { kind: 'decimal', semantic: 'money', args: typeArgs };
    if (/lat/.test(n)) return { kind: 'decimal', semantic: 'lat', args: typeArgs };
    if (/lon|lng/.test(n)) return { kind: 'decimal', semantic: 'lon', args: typeArgs };
    if (/rate|percent|ratio/.test(n)) return { kind: 'decimal', semantic: 'percent', args: typeArgs };
    return { kind: 'decimal', semantic: 'generic', args: typeArgs };
  }
  if (/^(bool|boolean)$/.test(t)) return { kind: 'boolean' };
  if (/^(date)$/.test(t)) return { kind: 'date' };
  if (/^(timestamp|datetime)/.test(t)) {
    if (/created/.test(n)) return { kind: 'datetime', semantic: 'created' };
    if (/updated|modified/.test(n)) return { kind: 'datetime', semantic: 'updated' };
    if (/deleted/.test(n)) return { kind: 'datetime', semantic: 'deleted_nullable' };
    return { kind: 'datetime', semantic: 'generic' };
  }
  if (/^time$/.test(t)) return { kind: 'time' };
  if (/^(uuid|guid|uniqueidentifier)$/.test(t)) return { kind: 'uuid' };
  if (/^(json|jsonb)$/.test(t)) return { kind: 'json' };

  if (/^(varchar|char|character|text|nvarchar|nchar|string|clob|tinytext|mediumtext|longtext|character varying)/.test(t)) {
    const maxLen = typeArgs[0] ? parseInt(typeArgs[0], 10) : null;
    if (/email/.test(n)) return { kind: 'string', semantic: 'email', maxLen };
    if (/^(first_?name|fname|given_?name)/.test(n)) return { kind: 'string', semantic: 'firstName', maxLen };
    if (/^(last_?name|lname|surname|family_?name)/.test(n)) return { kind: 'string', semantic: 'lastName', maxLen };
    if (/^(full_?name|display_?name)$/.test(n)) return { kind: 'string', semantic: 'fullName', maxLen };
    if (/^name$/.test(n)) return { kind: 'string', semantic: 'genericName', maxLen };
    if (/username|user_?login|handle/.test(n)) return { kind: 'string', semantic: 'username', maxLen };
    if (/phone|mobile|cell/.test(n)) return { kind: 'string', semantic: 'phone', maxLen };
    if (/^(address|street)/.test(n)) return { kind: 'string', semantic: 'street', maxLen };
    if (/^city$/.test(n)) return { kind: 'string', semantic: 'city', maxLen };
    if (/^(state|province)$/.test(n)) return { kind: 'string', semantic: 'state', maxLen };
    if (/^country$/.test(n)) return { kind: 'string', semantic: 'country', maxLen };
    if (/^(zip|postal)/.test(n)) return { kind: 'string', semantic: 'zip', maxLen };
    if (/url|link|website|domain/.test(n)) return { kind: 'string', semantic: 'url', maxLen };
    if (/slug/.test(n)) return { kind: 'string', semantic: 'slug', maxLen };
    if (/job_?title|^role$|^position$|occupation/.test(n)) return { kind: 'string', semantic: 'jobTitle', maxLen };
    if (/title$/.test(n)) return { kind: 'string', semantic: 'title', maxLen };
    if (/description|bio|summary|notes?$|comment/.test(n)) return { kind: 'string', semantic: 'paragraph', maxLen };
    if (/password|pwd|hash/.test(n)) return { kind: 'string', semantic: 'hash', maxLen };
    if (/status|state$/.test(n)) return { kind: 'string', semantic: 'status', maxLen };
    if (/code$/.test(n)) return { kind: 'string', semantic: 'code', maxLen };
    if (/color|colour/.test(n)) return { kind: 'string', semantic: 'color', maxLen };
    if (/sku/.test(n)) return { kind: 'string', semantic: 'sku', maxLen };
    if (/company|organization|employer/.test(n)) return { kind: 'string', semantic: 'company', maxLen };
    if (/^ip(_address)?$/.test(n)) return { kind: 'string', semantic: 'ip', maxLen };
    if (/^category|category$|^type$|^kind$/.test(n)) return { kind: 'string', semantic: 'category', maxLen };
    if (/^gender|^sex$/.test(n)) return { kind: 'string', semantic: 'gender', maxLen };
    if (/^(department|dept)$/.test(n)) return { kind: 'string', semantic: 'department', maxLen };
    return { kind: 'string', semantic: 'generic', maxLen };
  }
  if (/^(enum|set)$/.test(t)) return { kind: 'enum', options: typeArgs.map(s => s.replace(/^'|'$/g, '')) };
  if (/^(blob|bytea|binary|varbinary)/.test(t)) return { kind: 'binary' };

  return { kind: 'string', semantic: 'generic', maxLen: null };
}

/**
 * buildSchema - the engine-agnostic core.
 *
 * @param {Array} rawColumns - [{ tableName, columnName, dataType, charMaxLen,
 *                                numericPrecision, numericScale, isNullable,
 *                                columnDefault, ordinalPosition, enumValues? }]
 * @param {Array} rawPrimaryKeys - [{ tableName, columnName }]
 * @param {Array} rawForeignKeys - [{ tableName, columnName, refTable, refColumn }]
 * @param {Array} rawUniques - [{ tableName, columnName, constraintName }]
 * @returns {{ tables: object, order: string[] }}
 */
function buildSchema(rawColumns, rawPrimaryKeys, rawForeignKeys, rawUniques) {
  const tables = {};

  const ensureTable = (name) => {
    if (!tables[name]) {
      tables[name] = { name, columns: [], primaryKey: [], foreignKeys: [], uniques: [] };
    }
    return tables[name];
  };

  // columns, in ordinal order
  const sortedCols = [...rawColumns].sort((a, b) => a.ordinalPosition - b.ordinalPosition);
  for (const row of sortedCols) {
    const table = ensureTable(row.tableName);
    const typeArgs = [];
    if (row.enumValues && row.enumValues.length) {
      typeArgs.push(...row.enumValues);
    } else if (row.displayWidth != null) {
      typeArgs.push(String(row.displayWidth));
    } else if (row.numericPrecision != null && row.numericScale != null) {
      typeArgs.push(String(row.numericPrecision), String(row.numericScale));
    } else if (row.charMaxLen != null) {
      typeArgs.push(String(row.charMaxLen));
    }

    const category = row.enumValues && row.enumValues.length
      ? { kind: 'enum', options: row.enumValues }
      : classifyType(row.dataType, typeArgs, row.columnName);

    table.columns.push({
      name: row.columnName,
      rawType: row.dataType,
      typeArgs,
      notNull: row.isNullable === false,
      isPK: false,   // filled in below
      isFK: false,   // filled in below
      isUnique: false, // filled in below
      autoIncrement: !!row.isAutoIncrement,
      default: row.columnDefault != null ? String(row.columnDefault) : null,
      category,
    });
  }

  // primary keys
  for (const row of rawPrimaryKeys) {
    const table = ensureTable(row.tableName);
    if (!table.primaryKey.includes(row.columnName)) table.primaryKey.push(row.columnName);
  }

  // foreign keys - group by (table, constraint) isn't available uniformly across
  // engines for composite FKs, so we treat each FK row as a single-column FK.
  // (Composite FKs are rare in practice and the frontend generator only reads
  // fk.columns[0]/fk.refColumns[0] today, so this matches existing behavior.)
  for (const row of rawForeignKeys) {
    const table = ensureTable(row.tableName);
    table.foreignKeys.push({
      columns: [row.columnName],
      refTable: row.refTable,
      refColumns: [row.refColumn],
    });
  }

  // unique constraints (single-column, grouped)
  const uniqueSeen = {};
  for (const row of rawUniques) {
    const table = ensureTable(row.tableName);
    const key = row.tableName + '.' + row.columnName;
    if (!uniqueSeen[key]) {
      uniqueSeen[key] = true;
      table.uniques.push([row.columnName]);
    }
  }

  // apply isPK / isUnique / isFK + fkRef flags onto columns, same as engine.js
  for (const table of Object.values(tables)) {
    for (const col of table.columns) {
      col.isPK = table.primaryKey.includes(col.name);
      col.isUnique = table.uniques.some(u => u.length === 1 && u[0] === col.name);
      // PKs are implicitly NOT NULL in every engine, even when driver metadata
      // says otherwise (e.g. SQLite's INTEGER PRIMARY KEY rowid alias).
      if (col.isPK) col.notNull = true;
    }
    for (const fk of table.foreignKeys) {
      for (const colName of fk.columns) {
        const col = table.columns.find(c => c.name === colName);
        if (col) {
          col.isFK = true;
          col.fkRef = { table: fk.refTable, column: fk.refColumns[0] };
        }
      }
    }
  }

  const order = topoSort(tables, Object.keys(tables));
  return { tables, order };
}

function topoSort(tables, names) {
  const visited = new Set();
  const result = [];
  function visit(name) {
    if (visited.has(name) || !tables[name]) return;
    visited.add(name);
    for (const fk of tables[name].foreignKeys) {
      if (fk.refTable !== name) visit(fk.refTable);
    }
    result.push(name);
  }
  for (const name of names) visit(name);
  return result;
}

module.exports = { buildSchema, classifyType };
