// Try the service without a connected number.
//   npm run demo:seed   → sends signed fake webhooks (8 contacts, ~30 messages) to BASE_URL
//   npm run demo:clear  → deletes only the demo contacts, their chats/messages, and their raw events
import './load-env.js'
import { createHmac } from 'node:crypto'
import { sql } from 'kysely'
import { createDb } from '../src/db/client.js'
import { buildDemoPayloads, DEMO_PREFIX, DEMO_SUMMARY } from '../src/demo/demo-data.js'
import { readEnv } from '../src/env.js'

const command = process.argv[2]

if (command === 'seed') {
  const env = readEnv(process.env, ['BASE_URL', 'META_APP_SECRET'])
  const url = `${env.BASE_URL}/webhooks/whatsapp`
  let ok = 0
  for (const payload of buildDemoPayloads()) {
    const body = JSON.stringify(payload)
    const signature = `sha256=${createHmac('sha256', env.META_APP_SECRET).update(body).digest('hex')}`
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature }, body })
    if (res.ok) ok++
    else console.error(`✗ ${res.status} ${await res.text()}`)
  }
  console.log(`sent ${ok} webhooks to ${url} (${DEMO_SUMMARY.contacts} contacts, ${DEMO_SUMMARY.messages} messages)`)
  if (ok === 0) process.exitCode = 1
} else if (command === 'clear') {
  const env = readEnv(process.env, ['DATABASE_URL'])
  const db = createDb(env.DATABASE_URL)
  try {
    const contacts = await db.deleteFrom('contacts').where('wa_id', 'like', `${DEMO_PREFIX}%`).executeTakeFirst()
    const events = await db
      .deleteFrom('webhook_events')
      .where(sql<boolean>`payload::text like ${`%${DEMO_PREFIX}%`}`)
      .executeTakeFirst()
    console.log(`removed ${contacts.numDeletedRows} demo contacts (with their chats and messages) and ${events.numDeletedRows} demo webhook events`)
  } finally {
    await db.destroy()
  }
} else {
  console.error('usage: tsx scripts/demo.ts seed|clear')
  process.exit(1)
}
