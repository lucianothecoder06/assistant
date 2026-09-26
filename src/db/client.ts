import { attachDatabasePool } from '@vercel/functions'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Database } from './schema.js'

// pg returns bigint (int8) as string by default; our ids and counts fit in a JS number.
pg.types.setTypeParser(20, (value) => Number.parseInt(value, 10))

export type DB = Kysely<Database>

/**
 * Neon/Vercel strings say `sslmode=require`. pg already treats that as `verify-full` (certificate
 * checked) but warns it will weaken to libpq semantics in pg v9; pin the strict mode explicitly.
 */
export function strictSsl(connectionString: string): string {
  return connectionString.replace(/([?&]sslmode=)(prefer|require|verify-ca)\b/, '$1verify-full')
}

export function createDb(connectionString: string): DB {
  const pool = new pg.Pool({ connectionString: strictSsl(connectionString), max: 5, idleTimeoutMillis: 5_000 })
  // Lets Vercel Fluid compute close idle connections before an instance is suspended.
  attachDatabasePool(pool)
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
}
