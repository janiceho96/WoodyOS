import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { db } from './client.js';

const here = dirname(fileURLToPath(import.meta.url));
const directory = join(here, 'migrations');

async function migrate() {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const applied = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((row) => row.name));
  for (const name of (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort()) {
    if (applied.has(name)) continue;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(await readFile(join(directory, name), 'utf8'));
      await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
      await client.query('COMMIT');
      console.log(`Applied ${name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  await db.end();
}

migrate().catch((error) => { console.error(error); process.exit(1); });
