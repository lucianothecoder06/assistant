import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { serve, type ServerType } from '@hono/node-server'
import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { unaccent } from '@electric-sql/pglite/contrib/unaccent'
import { getMigrations } from 'better-auth/db/migration'
import { Kysely } from 'kysely'
import { PGliteDialect } from 'kysely-pglite-dialect'
import { createApp } from '../src/create-app.js'
import { authOptions, createAuth } from '../src/auth/auth.js'
import type { DB } from '../src/db/client.js'
import { migrateToLatest } from '../src/db/migrate.js'
import type { Database } from '../src/db/schema.js'
import type { Env } from '../src/env.js'

export const TEST_ENV: Env = {
  DATABASE_URL: 'pglite://memory',
  BASE_URL: 'http://localhost:3000',
  BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-0123456789',
  OWNER_EMAIL: 'owner@example.com',
  META_APP_SECRET: 'meta-app-secret',
  META_VERIFY_TOKEN: 'verify-me',
  CRON_SECRET: 'cron-secret',
}

export const OWNER_PASSWORD = 'correct horse battery staple'

export async function createTestDb(env: Env = TEST_ENV): Promise<DB> {
  const pglite = new PGlite({ extensions: { pg_trgm, unaccent } })
  const db = new Kysely<Database>({ dialect: new PGliteDialect(pglite) })
  await migrateToLatest(db)
  const { runMigrations } = await getMigrations(authOptions(db, env))
  await runMigrations()
  return db
}

export async function createTestApp(options: { env?: Env; db?: DB } = {}) {
  const env = options.env ?? TEST_ENV
  const db = options.db ?? (await createTestDb(env))
  const auth = createAuth(db, env)
  const pending: Promise<unknown>[] = []
  const app = createApp({ db, auth, env, background: (task) => pending.push(task) })
  /** Waits for everything the app scheduled "after the response". */
  const settle = async () => {
    while (pending.length) await Promise.all(pending.splice(0))
  }
  return { app, db, auth, env, settle }
}

/** Starts a real HTTP server; needed where the app calls itself (JWKS lookups during token checks). */
export async function startTestServer(options: { db?: DB } = {}) {
  let handler: ((request: Request) => Response | Promise<Response>) | undefined
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: (request) => handler!(request), port: 0, hostname: '127.0.0.1' }, () => resolve(s))
  })
  const { port } = server.address() as AddressInfo
  const env = { ...TEST_ENV, BASE_URL: `http://localhost:${port}` }
  const ctx = await createTestApp({ env, db: options.db ?? (await createTestDb(env)) })
  handler = ctx.app.fetch
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()))
  return { ...ctx, baseUrl: env.BASE_URL, close }
}

export function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
}

export function sign(body: string, secret = TEST_ENV.META_APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

export async function postWebhook(app: { request: (path: string, init: RequestInit) => Response | Promise<Response> }, body: string, signature: string | null = sign(body)) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (signature !== null) headers['x-hub-signature-256'] = signature
  return app.request('/webhooks/whatsapp', { method: 'POST', headers, body })
}
