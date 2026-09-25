export interface Env {
  DATABASE_URL: string
  /** Public origin of the deployment, e.g. https://whatsapp-mcp.vercel.app (no trailing slash). */
  BASE_URL: string
  BETTER_AUTH_SECRET: string
  /** The only account allowed to authorize MCP clients. */
  OWNER_EMAIL: string
  /** Meta app secret, used to verify X-Hub-Signature-256 on webhooks. */
  META_APP_SECRET: string
  /** Arbitrary string you also type into the Meta webhook config (GET verification). */
  META_VERIFY_TOKEN: string
  /** Vercel sends `Authorization: Bearer $CRON_SECRET` on cron invocations. */
  CRON_SECRET: string
}

const REQUIRED = [
  'DATABASE_URL',
  'BASE_URL',
  'BETTER_AUTH_SECRET',
  'OWNER_EMAIL',
  'META_APP_SECRET',
  'META_VERIFY_TOKEN',
  'CRON_SECRET',
] as const satisfies readonly (keyof Env)[]

export function readEnv(source: Record<string, string | undefined> = process.env): Env {
  const missing = REQUIRED.filter((key) => !source[key])
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`)
  }
  const env = Object.fromEntries(REQUIRED.map((key) => [key, source[key]!])) as unknown as Env
  env.BASE_URL = env.BASE_URL.replace(/\/+$/, '')
  env.OWNER_EMAIL = env.OWNER_EMAIL.toLowerCase()
  if (env.BETTER_AUTH_SECRET.length < 32) {
    throw new Error('BETTER_AUTH_SECRET must be at least 32 characters')
  }
  return env
}
