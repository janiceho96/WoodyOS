import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('runtime trace forward migration', () => {
  it('uses a non-keyword explicit alias for action authorization backfills', async () => {
    const sql = await readFile(
      new URL('../src/db/migrations/031a_runtime_trace_backfill.sql', import.meta.url),
      'utf8',
    );

    expect(sql).not.toMatch(/UPDATE\s+action_authorizations\s+authorization\b/i);
    expect(sql.match(/UPDATE\s+action_authorizations\s+AS\s+auth\b/gi)).toHaveLength(2);
  });
});
