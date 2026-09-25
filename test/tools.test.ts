import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../src/db/client.js'
import type { Direction } from '../src/db/schema.js'
import { findContacts, getConversation, listChats, listUnanswered } from '../src/mcp/queries.js'
import { createMcpServer } from '../src/mcp/server.js'
import { createTestApp, createTestDb, fixture, postWebhook } from './helpers.js'

const NOW = new Date('2026-09-25T12:00:00Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000)

let db: DB
let seq = 0

/** Inserts a message and updates the chat markers the same way the processor does. */
async function seedMessage(waId: string, direction: Direction, at: Date, text: string, opts: { name?: string; type?: string } = {}) {
  const { id: contactId } = await db
    .insertInto('contacts')
    .values({ wa_id: waId, saved_name: opts.name ?? null })
    .onConflict((oc) => oc.column('wa_id').doUpdateSet({ wa_id: waId }))
    .returning('id')
    .executeTakeFirstOrThrow()
  await db.insertInto('chats').values({ contact_id: contactId }).onConflict((oc) => oc.column('contact_id').doNothing()).execute()
  const { id: chatId } = await db.selectFrom('chats').select('id').where('contact_id', '=', contactId).executeTakeFirstOrThrow()
  await db
    .insertInto('messages')
    .values({
      wamid: `wamid.SEED_${++seq}`,
      chat_id: chatId,
      direction,
      source: 'live',
      type: opts.type ?? 'text',
      text_body: text,
      media: null,
      status: null,
      sent_at: at,
      raw: '{}',
    })
    .execute()
  const col = direction === 'inbound' ? 'last_inbound_at' : 'last_outbound_at'
  const { sql } = await import('kysely')
  await db
    .updateTable('chats')
    .set({ last_message_at: sql`greatest(last_message_at, ${at})`, [col]: sql`greatest(${sql.ref(col)}, ${at})` })
    .where('id', '=', chatId)
    .execute()
  return chatId
}

beforeEach(async () => {
  db = await createTestDb()
})

describe('list_unanswered', () => {
  it('lists chats whose last message is inbound and older than N hours, longest wait first', async () => {
    await seedMessage('521000000001', 'inbound', hoursAgo(10), 'hace diez horas', { name: 'Ana' })
    await seedMessage('521000000002', 'inbound', hoursAgo(5), 'hace cinco horas', { name: 'Beto' })
    const rows = await listUnanswered(db, { hours: 4, limit: 50, now: NOW })
    expect(rows.map((r) => r.name)).toEqual(['Ana', 'Beto'])
    expect(rows[0]).toMatchObject({ waiting_hours: 10, last_message: 'hace diez horas' })
  })

  it('excludes chats waiting less than the threshold', async () => {
    await seedMessage('521000000001', 'inbound', hoursAgo(3.9), 'reciente')
    expect(await listUnanswered(db, { hours: 4, limit: 50, now: NOW })).toEqual([])
  })

  it('includes a chat waiting exactly the threshold', async () => {
    await seedMessage('521000000001', 'inbound', hoursAgo(4), 'justo cuatro horas')
    expect(await listUnanswered(db, { hours: 4, limit: 50, now: NOW })).toHaveLength(1)
  })

  it('excludes chats where I replied after their last message', async () => {
    await seedMessage('521000000001', 'inbound', hoursAgo(10), 'pregunta')
    await seedMessage('521000000001', 'outbound', hoursAgo(9), 'respuesta')
    expect(await listUnanswered(db, { hours: 4, limit: 50, now: NOW })).toEqual([])
  })

  it('includes chats where they wrote again after my reply', async () => {
    await seedMessage('521000000001', 'inbound', hoursAgo(10), 'pregunta')
    await seedMessage('521000000001', 'outbound', hoursAgo(9), 'respuesta')
    await seedMessage('521000000001', 'inbound', hoursAgo(6), 'otra pregunta')
    const rows = await listUnanswered(db, { hours: 4, limit: 50, now: NOW })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ waiting_hours: 6, last_message: 'otra pregunta' })
  })

  it('excludes chats where the owner wrote last and nobody replied', async () => {
    await seedMessage('521000000001', 'outbound', hoursAgo(20), 'hola, ¿sigues interesado?')
    expect(await listUnanswered(db, { hours: 4, limit: 50, now: NOW })).toEqual([])
  })

  it('treats a same-second reply as answered', async () => {
    const at = hoursAgo(8)
    await seedMessage('521000000001', 'inbound', at, 'pregunta')
    await seedMessage('521000000001', 'outbound', at, 'respuesta automática')
    expect(await listUnanswered(db, { hours: 4, limit: 50, now: NOW })).toEqual([])
  })

  it('hours=0 returns every chat waiting on me', async () => {
    await seedMessage('521000000001', 'inbound', hoursAgo(0.01), 'ahorita')
    expect(await listUnanswered(db, { hours: 0, limit: 50, now: NOW })).toHaveLength(1)
  })

  it('does not count a reaction as the contact writing again', async () => {
    const ctx = await createTestApp({ db })
    await postWebhook(ctx.app, fixture('echo-text.json'))
    const reaction = JSON.parse(fixture('messages-text.json'))
    reaction.entry[0].changes[0].value.messages[0] = {
      from: '5215512345678',
      id: 'wamid.REACTION_1',
      timestamp: '1790157600',
      type: 'reaction',
      reaction: { message_id: 'wamid.ECHO_OUT_1', emoji: '👍' },
    }
    await postWebhook(ctx.app, JSON.stringify(reaction))
    await ctx.settle()
    expect(await listUnanswered(db, { hours: 0, limit: 50, now: NOW })).toEqual([])
  })
})

describe('get_conversation pagination', () => {
  it('pages backwards from the newest messages, each page oldest→newest', async () => {
    let chatId = 0
    for (let i = 1; i <= 5; i++) chatId = await seedMessage('521000000001', i % 2 ? 'inbound' : 'outbound', hoursAgo(10 - i), `m${i}`)

    const latest = await getConversation(db, { chat_id: chatId, limit: 2 })
    expect(latest.messages.map((m) => m.text)).toEqual(['m4', 'm5'])
    expect(latest.newer_cursor).toBeNull()
    expect(latest.older_cursor).not.toBeNull()

    const older = await getConversation(db, { chat_id: chatId, limit: 2, before: latest.older_cursor! })
    expect(older.messages.map((m) => m.text)).toEqual(['m2', 'm3'])

    const oldest = await getConversation(db, { chat_id: chatId, limit: 2, before: older.older_cursor! })
    expect(oldest.messages.map((m) => m.text)).toEqual(['m1'])
    expect(oldest.older_cursor).toBeNull()

    const forward = await getConversation(db, { chat_id: chatId, limit: 2, after: oldest.newer_cursor! })
    expect(forward.messages.map((m) => m.text)).toEqual(['m2', 'm3'])
  })

  it('keeps messages with identical timestamps in a stable order across pages', async () => {
    const at = hoursAgo(1)
    let chatId = 0
    for (let i = 1; i <= 4; i++) chatId = await seedMessage('521000000001', 'inbound', at, `same${i}`)
    const first = await getConversation(db, { chat_id: chatId, limit: 2 })
    const second = await getConversation(db, { chat_id: chatId, limit: 2, before: first.older_cursor! })
    expect([...second.messages, ...first.messages].map((m) => m.text)).toEqual(['same1', 'same2', 'same3', 'same4'])
  })
})

describe('list_chats', () => {
  it('orders by most recent activity and paginates with a cursor', async () => {
    await seedMessage('521000000001', 'inbound', hoursAgo(3), 'a', { name: 'Ana' })
    await seedMessage('521000000002', 'inbound', hoursAgo(1), 'b', { name: 'Beto' })
    await seedMessage('521000000003', 'outbound', hoursAgo(2), 'c', { name: 'Carla' })
    const first = await listChats(db, { limit: 2 })
    expect(first.chats.map((c) => c.name)).toEqual(['Beto', 'Carla'])
    expect(first.chats[1]).toMatchObject({ last_from: 'me', preview: 'c' })
    const second = await listChats(db, { limit: 2, cursor: first.next_cursor! })
    expect(second.chats.map((c) => c.name)).toEqual(['Ana'])
    expect(second.next_cursor).toBeNull()
  })
})

describe('find_contact', () => {
  beforeEach(async () => {
    await seedMessage('5215512345678', 'inbound', hoursAgo(1), 'hola', { name: 'María José Hernández' })
    await seedMessage('5213398765432', 'inbound', hoursAgo(2), 'hola', { name: 'Jorge Ramírez' })
  })

  it('matches names without accents and with typos', async () => {
    expect((await findContacts(db, 'maria jose', 5))[0]?.name).toBe('María José Hernández')
    expect((await findContacts(db, 'Jorje Ramires', 5))[0]?.name).toBe('Jorge Ramírez')
  })

  it('matches partial phone numbers in any format', async () => {
    const [match] = await findContacts(db, '+52 1 55 1234-5678', 5)
    expect(match).toMatchObject({ name: 'María José Hernández', wa_id: '5215512345678', score: 1 })
    expect((await findContacts(db, '98765', 5))[0]?.name).toBe('Jorge Ramírez')
  })

  it('returns nothing for unrelated queries', async () => {
    expect(await findContacts(db, 'zzzzqqq', 5)).toEqual([])
  })
})

describe('MCP tools end to end', () => {
  async function connect() {
    const ctx = await createTestApp({ db })
    for (const name of ['state-sync-contacts.json', 'history-chunk.json', 'messages-text.json', 'messages-image.json', 'echo-text.json']) {
      await postWebhook(ctx.app, fixture(name))
    }
    await ctx.settle()
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await createMcpServer(db).connect(serverTransport)
    const client = new Client({ name: 'test', version: '1' })
    await client.connect(clientTransport)
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args })
      const text = (result.content as { type: string; text: string }[])[0]!.text
      return { isError: result.isError, text, data: JSON.parse(text) }
    }
    return { call }
  }

  it('search_messages finds Spanish text across word forms and accents, with context', async () => {
    const { call } = await connect()
    // "envios" (no accent, plural) must match "envíos"/"enviamos"/"envío".
    const { data, text } = await call('search_messages', { query: 'envios queretaro', context: 1 })
    expect(data.count).toBeGreaterThan(0)
    const hit = data.results[0]
    expect(hit.name).toBe('María José Hernández')
    expect(hit.snippet).toContain('«')
    expect(hit.context_after.length + hit.context_before.length).toBeGreaterThan(0)
    expect(text).not.toContain('history_context') // never raw payloads
  })

  it('search_messages filters by contact and date range', async () => {
    const { call } = await connect()
    const byContact = await call('search_messages', { query: 'catalogo', contact: 'Jorge' })
    expect(byContact.data.results.map((r: { name: string }) => r.name)).toEqual(['Jorge Ramírez (Mesas)'])
    const outOfRange = await call('search_messages', { query: 'catalogo', from: '2026-09-01' })
    expect(outOfRange.data.count).toBe(0)
    // "sofa" appears in her question and in my echoed reply, both in September.
    const inRange = await call('search_messages', { query: 'sofa', from: '2026-09-01', to: '2026-09-30' })
    expect(inRange.data.count).toBe(2)
    const beforeRange = await call('search_messages', { query: 'sofa', to: '2026-08-31' })
    expect(beforeRange.data.count).toBe(0)
  })

  it('get_conversation resolves a contact by name and returns compact messages', async () => {
    const { call } = await connect()
    const { data, text } = await call('get_conversation', { contact: 'maria jose' })
    expect(data.name).toBe('María José Hernández')
    expect(data.messages).toHaveLength(6)
    expect(Object.keys(data.messages[0]).sort()).toEqual(['at', 'from', 'id', 'text', 'type'])
    expect(data.messages[2]).toMatchObject({ type: 'document', media: { filename: 'factura-marzo.pdf' } })
    expect(text).not.toMatch(/"raw"|sha256|wamid\./)
  })

  it('get_conversation reports ambiguity instead of guessing', async () => {
    const { call } = await connect()
    await seedMessage('5215599990000', 'inbound', hoursAgo(1), 'x', { name: 'María José López' })
    const { isError, data } = await call('get_conversation', { contact: 'María José' })
    expect(isError).toBe(true)
    expect(data.candidates.length).toBeGreaterThanOrEqual(2)
  })

  it('exposes only read-only tools', async () => {
    const ctx = await createTestApp({ db })
    void ctx
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await createMcpServer(db).connect(serverTransport)
    const client = new Client({ name: 'test', version: '1' })
    await client.connect(clientTransport)
    const { tools } = await client.listTools()
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true)
    expect(tools.map((t) => t.name).join(' ')).not.toMatch(/send|reply|write|delete/)
  })
})
