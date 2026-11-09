import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// int8 (bigint) als Zahl zurückgeben – unsere Werte (Cent-Beträge, Zähler) bleiben weit unter 2^53.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));
// numeric als Zahl (z. B. audit_rate)
pg.types.setTypeParser(1700, (v) => Number.parseFloat(v));

export type Queryable = Pick<pg.PoolClient, 'query'>;

export interface Db {
  pool: pg.Pool;
  query<T extends pg.QueryResultRow = any>(sql: string, params?: unknown[]): Promise<pg.QueryResult<T>>;
  one<T extends pg.QueryResultRow = any>(sql: string, params?: unknown[]): Promise<T | null>;
  tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createDb(databaseUrl: string): Db {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  pool.on('error', (err) => {
    // Verbindungsfehler im Leerlauf nicht den Prozess abstürzen lassen
    console.error('[db] Pool-Fehler:', err.message);
  });
  return {
    pool,
    query: (sql, params) => pool.query(sql, params as any[]),
    async one(sql, params) {
      const r = await pool.query(sql, params as any[]);
      return (r.rows[0] as any) ?? null;
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** Führt alle noch nicht angewendeten SQL-Migrationen der Reihe nach aus. */
export async function migrate(db: Db, log: (msg: string) => void = () => {}): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  // Nur eine Instanz migriert gleichzeitig
  await db.tx(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(4711)');
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      log(`Migration ${file}`);
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    }
  });
}
