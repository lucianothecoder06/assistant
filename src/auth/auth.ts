import { mcp } from '@better-auth/mcp'
import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { APIError } from 'better-auth/api'
import { jwt } from 'better-auth/plugins'
import type { Kysely } from 'kysely'
import type { Env } from '../env.js'

export const AUTH_BASE_PATH = '/api/auth'
export const LOGIN_PATH = '/login'
export const CONSENT_PATH = '/consent'

type AuthEnv = Pick<Env, 'BASE_URL' | 'BETTER_AUTH_SECRET' | 'OWNER_EMAIL'>

export function mcpResourceUrl(env: Pick<Env, 'BASE_URL'>): string {
  return `${env.BASE_URL}/mcp`
}

export function authOptions(db: Kysely<any>, env: AuthEnv) {
  return {
    appName: 'WhatsApp MCP',
    baseURL: env.BASE_URL,
    basePath: AUTH_BASE_PATH,
    secret: env.BETTER_AUTH_SECRET,
    database: { db, type: 'postgres' },
    emailAndPassword: {
      enabled: true,
      // The owner account is created once with `npm run owner:create`. Nobody else can register.
      disableSignUp: true,
      minPasswordLength: 12,
    },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 30 },
    databaseHooks: {
      user: {
        create: {
          // Second lock behind disableSignUp: the only user row that can ever exist is the owner.
          before: async (user) => {
            if (user.email.toLowerCase() !== env.OWNER_EMAIL) {
              throw new APIError('FORBIDDEN', { message: 'Registration is closed' })
            }
          },
        },
      },
    },
    plugins: [
      jwt(),
      mcp({
        resource: mcpResourceUrl(env),
        loginPage: LOGIN_PATH,
        consentPage: CONSENT_PATH,
        // claude.ai registers itself as a public client via RFC 7591 before starting the flow.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationRequirePKCE: true,
        accessTokenExpiresIn: 60 * 60,
      }),
    ],
  } satisfies BetterAuthOptions
}

export function createAuth(db: Kysely<any>, env: AuthEnv) {
  return betterAuth(authOptions(db, env))
}

export type Auth = ReturnType<typeof createAuth>
