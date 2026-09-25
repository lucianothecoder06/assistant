// Applies app migrations, then creates/updates Better Auth's tables. Run on every deploy (idempotent).
import { getMigrations } from 'better-auth/db/migration'
import { authOptions } from '../src/auth/auth.js'
import { createDb } from '../src/db/client.js'
import { migrateToLatest } from '../src/db/migrate.js'
import { readEnv } from '../src/env.js'

const env = readEnv()
const db = createDb(env.DATABASE_URL)
try {
  await migrateToLatest(db)
  const { runMigrations, toBeCreated, toBeAdded } = await getMigrations(authOptions(db, env))
  await runMigrations()
  console.log(`migrations applied (auth: ${toBeCreated.length} tables created, ${toBeAdded.length} altered)`)
} finally {
  await db.destroy()
}
