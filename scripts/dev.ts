// Local server against a real DATABASE_URL: `npm run dev` (reads .env via Node's --env-file if you add it).
import './load-env.js'
import { serve } from '@hono/node-server'
import { createApp } from '../src/create-app.js'
import { createAuth } from '../src/auth/auth.js'
import { createDb } from '../src/db/client.js'
import { readEnv } from '../src/env.js'

const env = readEnv()
const db = createDb(env.DATABASE_URL)
const app = createApp({ db, auth: createAuth(db, env), env, background: (task) => void task })
const port = Number(process.env.PORT ?? 3000)
serve({ fetch: app.fetch, port }, () => console.log(`listening on http://localhost:${port}`))
