import { sql, type Expression, type SqlBool } from 'kysely'
import type { DB } from '../db/client.js'
import type { Direction, MediaMeta } from '../db/schema.js'

const displayName = sql<string>`coalesce(contacts.saved_name, contacts.profile_name, '+' || contacts.wa_id)`

export interface Cursor {
  at: string
  id: number
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

export function decodeCursor(value: string | undefined): Cursor | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (typeof parsed?.at === 'string' && typeof parsed?.id === 'number') return parsed
  } catch {}
  throw new Error('Invalid cursor')
}

const iso = (value: Date | string | null) => (value == null ? null : new Date(value).toISOString())

function truncate(text: string | null, max: number): string | null {
  if (text == null) return null
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// --- list_chats ---------------------------------------------------------------

export async function listChats(db: DB, opts: { limit: number; cursor?: string }) {
  const cursor = decodeCursor(opts.cursor)
  let query = db
    .selectFrom('chats')
    .innerJoin('contacts', 'contacts.id', 'chats.contact_id')
    .select([
      'chats.id as chat_id',
      displayName.as('name'),
      'contacts.wa_id',
      'chats.last_message_at',
      'chats.last_inbound_at',
      'chats.last_outbound_at',
    ])
    .select((eb) =>
      eb
        .selectFrom('messages')
        .select(sql<string>`coalesce(messages.text_body, '[' || messages.type || ']')`.as('preview'))
        .whereRef('messages.chat_id', '=', 'chats.id')
        .orderBy('messages.sent_at', 'desc')
        .orderBy('messages.id', 'desc')
        .limit(1)
        .as('preview'),
    )
    .where('chats.last_message_at', 'is not', null)
    .orderBy('chats.last_message_at', 'desc')
    .orderBy('chats.id', 'desc')
    .limit(opts.limit + 1)

  if (cursor) {
    query = query.where(sql<SqlBool>`(chats.last_message_at, chats.id) < (${cursor.at}::timestamptz, ${cursor.id})`)
  }

  const rows = await query.execute()
  const page = rows.slice(0, opts.limit)
  const last = page.at(-1)
  return {
    chats: page.map((row) => ({
      chat_id: row.chat_id,
      name: row.name,
      wa_id: row.wa_id,
      last_message_at: iso(row.last_message_at),
      last_from: lastFrom(row.last_inbound_at, row.last_outbound_at),
      preview: truncate(row.preview, 120),
    })),
    next_cursor:
      rows.length > opts.limit && last?.last_message_at ? encodeCursor({ at: iso(last.last_message_at)!, id: last.chat_id }) : null,
  }
}

function lastFrom(inbound: Date | null, outbound: Date | null): 'contact' | 'me' | null {
  if (!inbound && !outbound) return null
  if (!outbound) return 'contact'
  if (!inbound) return 'me'
  return new Date(inbound) > new Date(outbound) ? 'contact' : 'me'
}

// --- contact resolution -------------------------------------------------------

export interface ContactMatch {
  chat_id: number | null
  name: string
  wa_id: string
  last_message_at: string | null
  score: number
}

export async function findContacts(db: DB, query: string, limit: number): Promise<ContactMatch[]> {
  const q = query.trim()
  const digits = q.replace(/\D/g, '')
  const nameExpr = sql<string>`f_unaccent(lower(coalesce(contacts.saved_name, '') || ' ' || coalesce(contacts.profile_name, '')))`
  const needle = sql<string>`f_unaccent(lower(${q}))`

  const conditions: Expression<SqlBool>[] = [
    sql<SqlBool>`${nameExpr} like '%' || ${needle} || '%'`,
    sql<SqlBool>`word_similarity(${needle}, ${nameExpr}) > 0.35`,
  ]
  if (digits.length >= 4) {
    conditions.push(sql<SqlBool>`contacts.wa_id like '%' || ${digits} || '%'`)
  }

  const rows = await db
    .selectFrom('contacts')
    .leftJoin('chats', 'chats.contact_id', 'contacts.id')
    .select([
      'chats.id as chat_id',
      displayName.as('name'),
      'contacts.wa_id',
      'chats.last_message_at',
      sql<number>`greatest(
        word_similarity(${needle}, ${nameExpr}),
        case when ${nameExpr} like '%' || ${needle} || '%' then 0.9 else 0 end,
        case when ${digits.length >= 4 ? digits : null}::text is not null and contacts.wa_id like '%' || ${digits} || '%' then 1 else 0 end
      )`.as('score'),
    ])
    .where((eb) => eb.or(conditions))
    .orderBy('score', 'desc')
    .orderBy(sql`chats.last_message_at desc nulls last`)
    .limit(limit)
    .execute()

  return rows.map((row) => ({
    chat_id: row.chat_id,
    name: row.name,
    wa_id: row.wa_id,
    last_message_at: iso(row.last_message_at),
    score: Math.round(Number(row.score) * 100) / 100,
  }))
}

export type ChatResolution =
  | { ok: true; chat_id: number; name: string; wa_id: string }
  | { ok: false; reason: 'not_found' | 'ambiguous'; candidates: ContactMatch[] }

export async function resolveChat(db: DB, input: { chat_id?: number; contact?: string }): Promise<ChatResolution> {
  if (input.chat_id != null) {
    const row = await db
      .selectFrom('chats')
      .innerJoin('contacts', 'contacts.id', 'chats.contact_id')
      .select(['chats.id', displayName.as('name'), 'contacts.wa_id'])
      .where('chats.id', '=', input.chat_id)
      .executeTakeFirst()
    return row ? { ok: true, chat_id: row.id, name: row.name, wa_id: row.wa_id } : { ok: false, reason: 'not_found', candidates: [] }
  }
  const matches = (await findContacts(db, input.contact ?? '', 5)).filter((m) => m.chat_id != null)
  const [first, second] = matches
  if (!first) return { ok: false, reason: 'not_found', candidates: [] }
  // Exact phone match or a clear winner resolves directly; otherwise let the caller pick.
  const exact = matches.find((m) => m.score >= 1)
  const pick = exact ?? (!second || first.score - second.score >= 0.2 ? first : undefined)
  if (!pick) return { ok: false, reason: 'ambiguous', candidates: matches }
  return { ok: true, chat_id: pick.chat_id!, name: pick.name, wa_id: pick.wa_id }
}

// --- get_conversation -----------------------------------------------------------

export interface CompactMessage {
  id: number
  at: string
  from: 'contact' | 'me'
  type: string
  text: string | null
  media?: { mime_type?: string; filename?: string }
  status?: string
}

function compactMessage(row: {
  id: number
  sent_at: Date
  direction: Direction
  type: string
  text_body: string | null
  media: MediaMeta | null
  status: string | null
}): CompactMessage {
  const message: CompactMessage = {
    id: row.id,
    at: iso(row.sent_at)!,
    from: row.direction === 'inbound' ? 'contact' : 'me',
    type: row.type,
    text: row.text_body,
  }
  if (row.media && (row.media.mime_type || row.media.filename)) {
    message.media = { mime_type: row.media.mime_type, filename: row.media.filename }
  }
  if (row.direction === 'outbound' && row.status) message.status = row.status
  return message
}

const messageColumns = ['messages.id', 'messages.sent_at', 'messages.direction', 'messages.type', 'messages.text_body', 'messages.media', 'messages.status'] as const

export async function getConversation(
  db: DB,
  opts: { chat_id: number; limit: number; before?: string; after?: string },
) {
  const before = decodeCursor(opts.before)
  const after = decodeCursor(opts.after)

  let query = db.selectFrom('messages').select(messageColumns).where('messages.chat_id', '=', opts.chat_id).limit(opts.limit + 1)

  if (after) {
    // Paging forward in time: oldest first after the cursor.
    query = query
      .where(sql<SqlBool>`(messages.sent_at, messages.id) > (${after.at}::timestamptz, ${after.id})`)
      .orderBy('messages.sent_at', 'asc')
      .orderBy('messages.id', 'asc')
  } else {
    // Default and `before`: the most recent page, fetched newest-first then flipped.
    if (before) query = query.where(sql<SqlBool>`(messages.sent_at, messages.id) < (${before.at}::timestamptz, ${before.id})`)
    query = query.orderBy('messages.sent_at', 'desc').orderBy('messages.id', 'desc')
  }

  const rows = await query.execute()
  const hasMore = rows.length > opts.limit
  const page = rows.slice(0, opts.limit)
  if (!after) page.reverse()

  const first = page[0]
  const last = page.at(-1)
  const cursorOf = (row: (typeof page)[number]) => encodeCursor({ at: iso(row.sent_at)!, id: row.id })

  return {
    messages: page.map(compactMessage),
    // Older messages exist before this page?
    older_cursor: first && (after || hasMore) ? cursorOf(first) : null,
    // Newer messages exist after this page?
    newer_cursor: last && (after ? hasMore : Boolean(before)) ? cursorOf(last) : null,
  }
}

// --- search_messages ------------------------------------------------------------

export async function searchMessages(
  db: DB,
  opts: { query: string; chat_id?: number; from?: string; to?: string; limit: number; context: number },
) {
  const tsquery = sql`websearch_to_tsquery('spanish', f_unaccent(${opts.query}))`
  let query = db
    .selectFrom('messages')
    .innerJoin('chats', 'chats.id', 'messages.chat_id')
    .innerJoin('contacts', 'contacts.id', 'chats.contact_id')
    .select([
      ...messageColumns,
      'messages.chat_id',
      displayName.as('name'),
      sql<string>`ts_headline('spanish', messages.text_body, ${tsquery}, 'StartSel=«, StopSel=», MaxWords=30, MinWords=12, MaxFragments=2, FragmentDelimiter= … ')`.as('snippet'),
      sql<number>`ts_rank(messages.tsv, ${tsquery})`.as('rank'),
    ])
    .where(sql<SqlBool>`messages.tsv @@ ${tsquery}`)
    .orderBy('rank', 'desc')
    .orderBy('messages.sent_at', 'desc')
    .limit(opts.limit)

  if (opts.chat_id != null) query = query.where('messages.chat_id', '=', opts.chat_id)
  if (opts.from) query = query.where('messages.sent_at', '>=', new Date(opts.from))
  if (opts.to) query = query.where('messages.sent_at', '<=', new Date(opts.to))

  const hits = await query.execute()

  return Promise.all(
    hits.map(async (hit) => {
      const around = opts.context > 0 ? await contextAround(db, hit.chat_id, hit.sent_at, hit.id, opts.context) : { before: [], after: [] }
      return {
        chat_id: hit.chat_id,
        name: hit.name,
        message_id: hit.id,
        at: iso(hit.sent_at),
        from: hit.direction === 'inbound' ? 'contact' : 'me',
        snippet: hit.snippet,
        context_before: around.before.map(contextLine),
        context_after: around.after.map(contextLine),
      }
    }),
  )
}

async function contextAround(db: DB, chatId: number, sentAt: Date, id: number, n: number) {
  const base = () => db.selectFrom('messages').select(messageColumns).where('messages.chat_id', '=', chatId).limit(n)
  const pivot = iso(sentAt)
  const [before, after] = await Promise.all([
    base()
      .where(sql<SqlBool>`(messages.sent_at, messages.id) < (${pivot}::timestamptz, ${id})`)
      .orderBy('messages.sent_at', 'desc')
      .orderBy('messages.id', 'desc')
      .execute(),
    base()
      .where(sql<SqlBool>`(messages.sent_at, messages.id) > (${pivot}::timestamptz, ${id})`)
      .orderBy('messages.sent_at', 'asc')
      .orderBy('messages.id', 'asc')
      .execute(),
  ])
  return { before: before.reverse(), after }
}

function contextLine(row: Parameters<typeof compactMessage>[0]): string {
  const who = row.direction === 'inbound' ? 'contact' : 'me'
  return `${iso(row.sent_at)} ${who}: ${truncate(row.text_body ?? `[${row.type}]`, 160)}`
}

// --- list_unanswered --------------------------------------------------------------

export async function listUnanswered(db: DB, opts: { hours: number; limit: number; now?: Date }) {
  const now = opts.now ?? new Date()
  const threshold = new Date(now.getTime() - opts.hours * 3_600_000)

  const rows = await db
    .selectFrom('chats')
    .innerJoin('contacts', 'contacts.id', 'chats.contact_id')
    .select(['chats.id as chat_id', displayName.as('name'), 'contacts.wa_id', 'chats.last_inbound_at'])
    .select((eb) =>
      eb
        .selectFrom('messages')
        .select(sql<string>`coalesce(messages.text_body, '[' || messages.type || ']')`.as('t'))
        .whereRef('messages.chat_id', '=', 'chats.id')
        .where('messages.direction', '=', 'inbound')
        .orderBy('messages.sent_at', 'desc')
        .orderBy('messages.id', 'desc')
        .limit(1)
        .as('last_inbound_text'),
    )
    .where('chats.last_inbound_at', 'is not', null)
    // Last message is from the contact: nothing I sent is newer than their latest message.
    .where(sql<SqlBool>`chats.last_inbound_at > coalesce(chats.last_outbound_at, '-infinity'::timestamptz)`)
    .where('chats.last_inbound_at', '<=', threshold)
    .orderBy('chats.last_inbound_at', 'asc')
    .limit(opts.limit)
    .execute()

  return rows.map((row) => ({
    chat_id: row.chat_id,
    name: row.name,
    wa_id: row.wa_id,
    waiting_since: iso(row.last_inbound_at),
    waiting_hours: Math.floor(((now.getTime() - new Date(row.last_inbound_at!).getTime()) / 3_600_000) * 10) / 10,
    last_message: truncate(row.last_inbound_text, 200),
  }))
}
