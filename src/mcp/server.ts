import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { DB } from '../db/client.js'
import { findContacts, getConversation, listChats, listUnanswered, resolveChat, searchMessages } from './queries.js'

// Compact JSON keeps token usage down; nothing here ever includes the raw webhook payload.
const ok = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] })
const fail = (message: string, extra?: unknown): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify(extra ? { error: message, ...extra } : { error: message }) }],
})

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const
const isoDate = z.string().datetime({ offset: true }).or(z.string().date())

export function createMcpServer(db: DB): McpServer {
  const server = new McpServer(
    { name: 'whatsapp-archive', version: '1.0.0' },
    {
      instructions:
        'Read-only archive of the owner\'s 1:1 WhatsApp Business chats. "contact" is the other person, "me" is the owner. ' +
        'Timestamps are UTC ISO-8601. Most chats are in Spanish; search in Spanish. This server cannot send messages.',
    },
  )

  server.registerTool(
    'list_chats',
    {
      title: 'List chats',
      description: 'Chats ordered by most recent activity, with a preview of the last message. Paginate with next_cursor.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z.string().optional().describe('next_cursor from a previous call'),
      },
      annotations: readOnly,
    },
    async ({ limit, cursor }) => ok(await listChats(db, { limit, cursor })),
  )

  server.registerTool(
    'get_conversation',
    {
      title: 'Get conversation',
      description:
        'Messages of one chat, oldest to newest. Identify the chat by chat_id or by contact (name or phone number). ' +
        'Returns the most recent page by default; pass older_cursor as `before` to go back in time, or newer_cursor as `after` to go forward.',
      inputSchema: {
        chat_id: z.number().int().optional(),
        contact: z.string().min(1).optional().describe('Contact name or phone number (fuzzy)'),
        limit: z.number().int().min(1).max(200).default(50),
        before: z.string().optional().describe('older_cursor from a previous call'),
        after: z.string().optional().describe('newer_cursor from a previous call'),
      },
      annotations: readOnly,
    },
    async ({ chat_id, contact, limit, before, after }) => {
      if (chat_id == null && !contact) return fail('Provide chat_id or contact')
      if (before && after) return fail('Use either before or after, not both')
      const chat = await resolveChat(db, { chat_id, contact })
      if (!chat.ok) {
        return fail(chat.reason === 'ambiguous' ? 'Several contacts match; retry with a chat_id' : 'No matching chat', {
          candidates: chat.candidates,
        })
      }
      const page = await getConversation(db, { chat_id: chat.chat_id, limit, before, after })
      return ok({ chat_id: chat.chat_id, name: chat.name, wa_id: chat.wa_id, ...page })
    },
  )

  server.registerTool(
    'search_messages',
    {
      title: 'Search messages',
      description:
        'Full-text search (Spanish stemming, accent-insensitive) across all chats. Supports "quoted phrases", OR, and -exclusions. ' +
        'Optional date range and contact filter. Returns highlighted snippets with surrounding messages.',
      inputSchema: {
        query: z.string().min(1),
        contact: z.string().min(1).optional().describe('Restrict to one contact (name or phone number)'),
        chat_id: z.number().int().optional(),
        from: isoDate.optional().describe('Inclusive start, ISO date or datetime'),
        to: isoDate.optional().describe('Inclusive end, ISO date or datetime'),
        limit: z.number().int().min(1).max(50).default(20),
        context: z.number().int().min(0).max(5).default(2).describe('Messages of context on each side'),
      },
      annotations: readOnly,
    },
    async ({ query, contact, chat_id, from, to, limit, context }) => {
      let chatId = chat_id
      if (chatId == null && contact) {
        const chat = await resolveChat(db, { contact })
        if (!chat.ok) return fail(chat.reason === 'ambiguous' ? 'Several contacts match; retry with a chat_id' : 'No matching chat', { candidates: chat.candidates })
        chatId = chat.chat_id
      }
      // A bare date as `to` means the whole day.
      const toBound = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59.999Z` : to
      const results = await searchMessages(db, { query, chat_id: chatId, from, to: toBound, limit, context })
      return ok({ count: results.length, results })
    },
  )

  server.registerTool(
    'list_unanswered',
    {
      title: 'List unanswered chats',
      description: 'Chats whose last message came from the contact and has been waiting at least `hours` without a reply. Longest-waiting first.',
      inputSchema: {
        hours: z.number().min(0).max(24 * 90).default(4),
        limit: z.number().int().min(1).max(100).default(50),
      },
      annotations: readOnly,
    },
    async ({ hours, limit }) => ok({ hours, chats: await listUnanswered(db, { hours, limit }) }),
  )

  server.registerTool(
    'find_contact',
    {
      title: 'Find contact',
      description: 'Fuzzy match contacts by name (accent-insensitive, typo-tolerant) or by any part of the phone number.',
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(25).default(10),
      },
      annotations: readOnly,
    },
    async ({ query, limit }) => ok({ matches: await findContacts(db, query, limit) }),
  )

  return server
}
