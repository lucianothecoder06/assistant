import { beforeEach, describe, expect, it } from 'vitest'
import { drainPendingEvents } from '../src/ingest/processor.js'
import { getConversation, listChats } from '../src/mcp/queries.js'
import { createTestApp, fixture, postWebhook } from './helpers.js'

let ctx: Awaited<ReturnType<typeof createTestApp>>
beforeEach(async () => {
  ctx = await createTestApp()
})

async function deliver(...names: string[]) {
  for (const name of names) {
    const res = await postWebhook(ctx.app, fixture(name))
    expect(res.status).toBe(200)
  }
  await ctx.settle()
}

const chatIdFor = async (waId: string) =>
  (
    await ctx.db
      .selectFrom('chats')
      .innerJoin('contacts', 'contacts.id', 'chats.contact_id')
      .select('chats.id')
      .where('contacts.wa_id', '=', waId)
      .executeTakeFirstOrThrow()
  ).id

describe('idempotency on wamid', () => {
  it('stores a message once no matter how often Meta redelivers it', async () => {
    await deliver('messages-text.json', 'messages-text.json', 'messages-text.json')
    const messages = await ctx.db.selectFrom('messages').select('wamid').execute()
    expect(messages).toEqual([{ wamid: 'wamid.LIVE_IN_1' }])
    // Every delivery is still recorded as its own raw event.
    const events = await ctx.db.selectFrom('webhook_events').select(['processed_at']).execute()
    expect(events).toHaveLength(3)
    expect(events.every((e) => e.processed_at !== null)).toBe(true)
  })

  it('reprocessing an already-processed event is a no-op', async () => {
    await deliver('history-chunk.json')
    await ctx.db.updateTable('webhook_events').set({ processed_at: null }).execute()
    await drainPendingEvents(ctx.db)
    expect(await ctx.db.selectFrom('messages').select('wamid').execute()).toHaveLength(4)
    expect(await ctx.db.selectFrom('chats').select('id').execute()).toHaveLength(2)
  })

  it('does not duplicate contacts or chats across sources', async () => {
    await deliver('state-sync-contacts.json', 'history-chunk.json', 'messages-text.json', 'echo-text.json')
    const contacts = await ctx.db.selectFrom('contacts').select('wa_id').orderBy('wa_id').execute()
    expect(contacts.map((c) => c.wa_id)).toEqual(['5213398765432', '5215512345678'])
    expect(await ctx.db.selectFrom('chats').select('id').execute()).toHaveLength(2)
  })
})

describe('merging history, live and echoes', () => {
  const expectedOrder = ['wamid.HIST_IN_1', 'wamid.HIST_OUT_1', 'wamid.HIST_IN_2', 'wamid.LIVE_IN_1', 'wamid.LIVE_IN_2', 'wamid.ECHO_OUT_1']

  async function conversationWamids() {
    const chatId = await chatIdFor('5215512345678')
    const page = await getConversation(ctx.db, { chat_id: chatId, limit: 50 })
    const ids = page.messages.map((m) => m.id)
    const rows = await ctx.db.selectFrom('messages').select(['id', 'wamid']).where('id', 'in', ids).execute()
    const byId = new Map(rows.map((r) => [r.id, r.wamid]))
    return { page, wamids: ids.map((id) => byId.get(id)) }
  }

  it('orders by send time regardless of arrival order (history arriving last)', async () => {
    await deliver('echo-text.json', 'messages-image.json', 'messages-text.json', 'history-chunk.json')
    const { page, wamids } = await conversationWamids()
    expect(wamids).toEqual(expectedOrder)
    expect(page.messages.map((m) => m.from)).toEqual(['contact', 'me', 'contact', 'contact', 'contact', 'me'])
  })

  it('produces the same result in natural arrival order', async () => {
    await deliver('history-chunk.json', 'messages-text.json', 'messages-image.json', 'echo-text.json')
    expect((await conversationWamids()).wamids).toEqual(expectedOrder)
  })

  it('tags each message with its source and keeps chat markers monotonic', async () => {
    await deliver('messages-text.json', 'echo-text.json', 'history-chunk.json')
    const sources = await ctx.db.selectFrom('messages').select(['wamid', 'source', 'direction']).orderBy('wamid').execute()
    expect(sources).toEqual([
      { wamid: 'wamid.ECHO_OUT_1', source: 'echo', direction: 'outbound' },
      { wamid: 'wamid.HIST_IN_1', source: 'history', direction: 'inbound' },
      { wamid: 'wamid.HIST_IN_2', source: 'history', direction: 'inbound' },
      { wamid: 'wamid.HIST_IN_3', source: 'history', direction: 'inbound' },
      { wamid: 'wamid.HIST_OUT_1', source: 'history', direction: 'outbound' },
      { wamid: 'wamid.LIVE_IN_1', source: 'live', direction: 'inbound' },
    ])

    // Old history arriving after live traffic must not move the markers backwards.
    const chat = await ctx.db.selectFrom('chats').selectAll().where('id', '=', await chatIdFor('5215512345678')).executeTakeFirstOrThrow()
    expect(chat.last_inbound_at?.toISOString()).toBe(new Date(1790150400 * 1000).toISOString())
    expect(chat.last_outbound_at?.toISOString()).toBe(new Date(1790154000 * 1000).toISOString())
    expect(chat.last_message_at?.toISOString()).toBe(new Date(1790154000 * 1000).toISOString())
  })

  it('keeps media metadata and captions but never downloads media', async () => {
    await deliver('messages-image.json', 'history-chunk.json')
    const image = await ctx.db.selectFrom('messages').selectAll().where('wamid', '=', 'wamid.LIVE_IN_2').executeTakeFirstOrThrow()
    expect(image.type).toBe('image')
    expect(image.text_body).toBe('Así quedó la sala')
    expect(image.media).toMatchObject({ id: '1003383421387256', mime_type: 'image/jpeg' })
    const doc = await ctx.db.selectFrom('messages').selectAll().where('wamid', '=', 'wamid.HIST_IN_2').executeTakeFirstOrThrow()
    expect(doc.media).toMatchObject({ filename: 'factura-marzo.pdf' })
  })
})

describe('statuses and contacts', () => {
  it('applies statuses forward-only even when they arrive out of order', async () => {
    await deliver('echo-text.json', 'statuses-read.json')
    const echo = await ctx.db.selectFrom('messages').select('status').where('wamid', '=', 'wamid.ECHO_OUT_1').executeTakeFirstOrThrow()
    // The fixture sends "read" then a late "delivered"; read must stick.
    expect(echo.status).toBe('read')
  })

  it('ignores statuses for messages it has never seen', async () => {
    await deliver('statuses-read.json')
    expect(await ctx.db.selectFrom('messages').select('id').execute()).toHaveLength(0)
    expect((await ctx.db.selectFrom('webhook_events').select('processed_at').executeTakeFirstOrThrow()).processed_at).not.toBeNull()
  })

  it('prefers the address-book name over the profile name', async () => {
    await deliver('messages-text.json', 'state-sync-contacts.json')
    const { chats } = await listChats(ctx.db, { limit: 10 })
    expect(chats[0]?.name).toBe('María José Hernández')

    // A later live message must not overwrite the saved name.
    await deliver('messages-image.json')
    expect((await listChats(ctx.db, { limit: 10 })).chats[0]?.name).toBe('María José Hernández')
  })

  it('treats a declined history share as a processed no-op', async () => {
    await deliver('history-declined.json')
    expect(await ctx.db.selectFrom('messages').select('id').execute()).toHaveLength(0)
    expect((await ctx.db.selectFrom('webhook_events').select('processed_at').executeTakeFirstOrThrow()).processed_at).not.toBeNull()
  })
})

describe('failure handling', () => {
  it('records failures, retries them, and gives up after 5 attempts', async () => {
    // Break processing for one event: a message whose chat insert will violate a constraint.
    const bad = JSON.parse(fixture('messages-text.json'))
    bad.entry[0].changes[0].value.messages[0].type = 'x'.repeat(10)
    await ctx.db.insertInto('webhook_events').values({ payload: JSON.stringify(bad) }).execute()
    await ctx.db.schema.alterTable('messages').addCheckConstraint('test_reject', (await import('kysely')).sql`type <> 'xxxxxxxxxx'`).execute()

    for (let i = 0; i < 7; i++) await drainPendingEvents(ctx.db)
    const event = await ctx.db.selectFrom('webhook_events').selectAll().executeTakeFirstOrThrow()
    expect(event.processed_at).toBeNull()
    expect(event.attempts).toBe(5)
    expect(event.last_error).toContain('test_reject')
    // The failure must not leave half-written rows behind.
    expect(await ctx.db.selectFrom('contacts').select('id').execute()).toHaveLength(0)
  })
})
