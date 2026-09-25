import { waitUntil } from '@vercel/functions'
import { createApp } from './app.js'
import { createAuth } from './auth/auth.js'
import { createDb } from './db/client.js'
import { readEnv } from './env.js'

const env = readEnv()
const db = createDb(env.DATABASE_URL)
const auth = createAuth(db, env)

// Vercel detects a default-exported Hono app and serves it as a single Fluid function.
export default createApp({ db, auth, env, background: waitUntil })
