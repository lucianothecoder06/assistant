import { describe, expect, it } from 'vitest'
import { buildDemoPayloads, DEMO_SUMMARY } from '../src/demo/demo-data.js'
import { findContacts, listChats, listUnanswered } from '../src/mcp/queries.js'
import { createTestApp, postWebhook } from './helpers.js'

describe('demo data', () => {
  it('ingests through the real webhook path and exercises every tool', async () => {
    const now = new Date()
    const ctx = await createTestApp()
    for (const payload of buildDemoPayloads(now)) {
      expect((await postWebhook(ctx.app, JSON.stringify(payload))).status).toBe(200)
    }
    await ctx.settle()

    expect(await ctx.db.selectFrom('messages').select('id').execute()).toHaveLength(DEMO_SUMMARY.messages)
    const { chats } = await listChats(ctx.db, { limit: 20 })
    expect(chats).toHaveLength(DEMO_SUMMARY.contacts)
    expect(chats[0]?.name).toBe('Sofía Guzmán')

    const waiting = await listUnanswered(ctx.db, { hours: 4, limit: 20, now })
    // Longest wait first; Fernanda's "lo pienso y te aviso" from two months ago also counts.
    expect(waiting.map((c) => c.name)).toEqual(['Fernanda Ruiz', 'Ana Lucía Torres', 'María José Hernández', 'Luis Ángel'])

    expect((await findContacts(ctx.db, 'roberto maderas', 5))[0]?.name).toContain('Roberto Díaz')
    const statuses = await ctx.db.selectFrom('messages').select('status').where('source', '=', 'echo').execute()
    expect(statuses.every((s) => s.status === 'read')).toBe(true)
  })
})
