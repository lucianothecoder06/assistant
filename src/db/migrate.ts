import type { Kysely } from 'kysely'
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration'
import * as m0001 from './migrations/0001_init.js'

// Registered statically so the migrations survive bundling on Vercel.
const migrations: Record<string, Migration> = {
  '0001_init': m0001,
}

const provider: MigrationProvider = {
  getMigrations: async () => migrations,
}

export async function migrateToLatest(db: Kysely<any>): Promise<void> {
  const migrator = new Migrator({ db, provider, migrationTableName: 'app_migrations' })
  const { error, results } = await migrator.migrateToLatest()
  for (const result of results ?? []) {
    if (result.status === 'Error') {
      throw new Error(`Migration ${result.migrationName} failed`, { cause: error })
    }
  }
  if (error) throw error
}
