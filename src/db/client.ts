import { attachDatabasePool } from '@vercel/functions'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Database } from './schema.js'

// pg returns bigint (int8) as string by default; our ids and counts fit in a JS number.
pg.types.setTypeParser(20, (value) => Number.parseInt(value, 10))

export type DB = Kysely<Database>

export function createDb(connectionString: string): DB {
  const pool = new pg.Pool({ connectionString, max: 5, idleTimeoutMillis: 5_000 })
  // Lets Vercel Fluid compute close idle connections before an instance is suspended.
  attachDatabasePool(pool)
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
}
