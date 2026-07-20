import pg from 'pg';

const { Pool } = pg;

export const db = new Pool({ connectionString: process.env.DATABASE_URL });

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values: unknown[] = []) {
  return db.query<T>(text, values);
}
