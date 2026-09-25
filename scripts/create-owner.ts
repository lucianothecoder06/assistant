// Creates (or resets the password of) the single owner account.
// Usage: OWNER_PASSWORD='…' npm run owner:create
import { createAuth } from '../src/auth/auth.js'
import { createDb } from '../src/db/client.js'
import { readEnv } from '../src/env.js'
import { upsertOwner } from '../src/auth/owner.js'

const env = readEnv()
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
