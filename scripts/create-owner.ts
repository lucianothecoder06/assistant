// Creates (or resets the password of) the single owner account.
// Usage: OWNER_PASSWORD='…' npm run owner:create
import './load-env.js'
import { createAuth } from '../src/auth/auth.js'
import { createDb } from '../src/db/client.js'
import { AUTH_KEYS, readEnv } from '../src/env.js'
import { upsertOwner } from '../src/auth/owner.js'

const env = readEnv(process.env, AUTH_KEYS)
const password = process.env.OWNER_PASSWORD
if (!password || password.length < 12) {
  console.error('Set OWNER_PASSWORD (min 12 characters) in the environment for this command only.')
  process.exit(1)
}

const db = createDb(env.DATABASE_URL)
try {
  const auth = createAuth(db, env)
  const result = await upsertOwner(auth, env.OWNER_EMAIL, password)
  console.log(`owner ${result} for ${env.OWNER_EMAIL}`)
} finally {
  await db.destroy()
}
