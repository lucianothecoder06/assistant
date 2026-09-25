import { waitUntil } from '@vercel/functions'
import { Hono } from 'hono'
import { createAuth } from './auth/auth.js'
import { createApp } from './create-app.js'
import { createDb } from './db/client.js'
import { readEnv } from './env.js'

const env = readEnv()
const db = createDb(env.DATABASE_URL)
const auth = createAuth(db, env)

// Vercel's zero-config Hono detection needs the entry file itself to import hono.
const app = new Hono().route('/', createApp({ db, auth, env, background: waitUntil }))
export default app
