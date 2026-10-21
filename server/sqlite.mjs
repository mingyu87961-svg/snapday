import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** D1-shaped SQLite adapter; statements always bind parameters separately. */
export function createDatabase(filename = ':memory:') {
  if (filename !== ':memory:') mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  const connection = new DatabaseSync(filename);
  connection.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (filename !== ':memory:') connection.exec('PRAGMA journal_mode = WAL;');
  connection.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  class Statement {
    constructor(sql, values = []) { this.sql = sql; this.values = values; }
    bind(...values) { return new Statement(this.sql, values); }
    first(column) {
      const row = connection.prepare(this.sql).get(...this.values);
      return row ? (column ? row[column] : { ...row }) : null;
    }
    all() { return { success: true, results: connection.prepare(this.sql).all(...this.values).map(row => ({ ...row })) }; }
    run() {
      const result = connection.prepare(this.sql).run(...this.values);
      return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    }
  }
  return {
    prepare(sql) { return new Statement(sql); },
    batch(statements) {
      connection.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(statement => statement.run());
        connection.exec('COMMIT');
        return results;
      } catch (error) { connection.exec('ROLLBACK'); throw error; }
    },
    close() { connection.close(); },
  };
}
