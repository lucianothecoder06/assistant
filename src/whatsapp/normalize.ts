import type { Direction, MediaMeta, MessageSource } from '../db/schema.js'

/**
 * Meta Cloud API webhook payloads → internal events.
 *
 * Fields handled (all under entry[].changes[] with the same envelope):
 *   messages            inbound messages + delivery statuses for outbound ones
 *   history             Coexistence backfill of up to 6 months of 1:1 chats, in chunks
 *   smb_message_echoes  messages the owner sends from the WhatsApp Business app
 *   smb_app_state_sync  address-book contacts from the WhatsApp Business app
 * Anything else is ignored. Parsing is defensive: one malformed item never drops its siblings.
 */

export interface MessageEvent {
  kind: 'message'
  wamid: string
  contactWaId: string
  contactProfileName: string | null
  direction: Direction
  source: MessageSource
  type: string
  text: string | null
  media: MediaMeta | null
  status: string | null
  sentAt: Date
  /** Whether this message moves the chat's "last inbound/outbound" markers. */
  countsAsActivity: boolean
  raw: object
}

export interface StatusEvent {
  kind: 'status'
  wamid: string
  status: string
}

export interface ContactEvent {
  kind: 'contact'
  action: 'add' | 'remove'
  waId: string
  name: string | null
}

export type NormalizedEvent = MessageEvent | StatusEvent | ContactEvent

type Json = Record<string, any>

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker'])
/** Types that aren't conversation turns: they shouldn't make a chat look (un)answered. */
const PASSIVE_TYPES = new Set(['reaction', 'system', 'unsupported', 'ephemeral', 'revoke', 'edit'])

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const asArray = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isObject) : [])
const str = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : typeof value === 'number' ? String(value) : null)
export const digitsOnly = (value: unknown): string => (str(value) ?? '').replace(/\D/g, '')

export function normalizeWebhook(payload: unknown): NormalizedEvent[] {
  if (!isObject(payload) || payload.object !== 'whatsapp_business_account') return []
  const events: NormalizedEvent[] = []

  for (const entry of asArray(payload.entry)) {
    for (const change of asArray(entry.changes)) {
      const value = isObject(change.value) ? change.value : {}
      const businessNumber = digitsOnly(value.metadata?.display_phone_number)
      switch (change.field) {
        case 'messages':
          events.push(...fromMessagesField(value))
          break
        case 'history':
          events.push(...fromHistoryField(value, businessNumber))
          break
        case 'smb_message_echoes':
          events.push(...fromEchoesField(value))
          break
        case 'smb_app_state_sync':
          events.push(...fromStateSyncField(value))
          break
      }
    }
  }
  return events
}

function fromMessagesField(value: Json): NormalizedEvent[] {
  const events: NormalizedEvent[] = []
  const profileNames = new Map<string, string>()
  for (const contact of asArray(value.contacts)) {
    const waId = digitsOnly(contact.wa_id)
    const name = str(contact.profile?.name)
    if (waId && name) profileNames.set(waId, name)
  }

  for (const message of asArray(value.messages)) {
    const contactWaId = digitsOnly(message.from)
    const event = toMessageEvent(message, {
      contactWaId,
      contactProfileName: profileNames.get(contactWaId) ?? null,
      direction: 'inbound',
      source: 'live',
    })
    if (event) events.push(event)
  }

  for (const status of asArray(value.statuses)) {
    const wamid = str(status.id)
    const state = str(status.status)
    if (wamid && state) events.push({ kind: 'status', wamid, status: state.toLowerCase() })
  }
  return events
}

function fromEchoesField(value: Json): NormalizedEvent[] {
  const events: NormalizedEvent[] = []
  for (const message of asArray(value.message_echoes)) {
    // An echo is always the owner writing to `to`.
    const event = toMessageEvent(message, {
      contactWaId: digitsOnly(message.to),
      contactProfileName: null,
      direction: 'outbound',
      source: 'echo',
    })
    if (event) events.push(event)
  }
  return events
}

function fromHistoryField(value: Json, businessNumber: string): NormalizedEvent[] {
  const events: NormalizedEvent[] = []
  for (const chunk of asArray(value.history)) {
    // A chunk with `errors` (e.g. the owner declined to share history) carries no threads.
    for (const thread of asArray(chunk.threads)) {
      const threadWaId = digitsOnly(thread.id)
      for (const message of asArray(thread.messages)) {
        const from = digitsOnly(message.from)
        // The thread id is the contact; a message not from the contact was sent by the owner.
        const contactWaId = threadWaId || (from === businessNumber ? digitsOnly(message.to) : from)
        const outbound = threadWaId ? from !== threadWaId : from === businessNumber
        const historyStatus = str(message.history_context?.status)
        const event = toMessageEvent(message, {
          contactWaId,
          contactProfileName: null,
          direction: outbound ? 'outbound' : 'inbound',
          source: 'history',
          status: outbound && historyStatus ? historyStatus.toLowerCase() : null,
        })
        if (event) events.push(event)
      }
    }
  }
  return events
}

function fromStateSyncField(value: Json): NormalizedEvent[] {
  const events: NormalizedEvent[] = []
  for (const item of asArray(value.state_sync)) {
    if (item.type !== 'contact' || !isObject(item.contact)) continue
    const waId = digitsOnly(item.contact.phone_number)
    if (!waId) continue
    const action = item.action === 'remove' ? 'remove' : 'add'
    const name = str(item.contact.full_name) ?? str(item.contact.first_name)
    events.push({ kind: 'contact', action, waId, name })
  }
  return events
}

function toMessageEvent(
  message: Json,
  context: { contactWaId: string; contactProfileName: string | null; direction: Direction; source: MessageSource; status?: string | null },
): MessageEvent | null {
  const wamid = str(message.id)
  const seconds = Number(message.timestamp)
  if (!wamid || !context.contactWaId || !Number.isFinite(seconds) || seconds <= 0) return null

  const type = str(message.type) ?? 'unknown'
  const { text, media } = extractContent(type, message)

  return {
    kind: 'message',
    wamid,
    contactWaId: context.contactWaId,
    contactProfileName: context.contactProfileName,
    direction: context.direction,
    source: context.source,
    type,
    text,
    media,
    status: context.status ?? (context.direction === 'outbound' ? 'sent' : null),
    sentAt: new Date(seconds * 1000),
    countsAsActivity: !PASSIVE_TYPES.has(type),
    raw: message,
  }
}

/** Pulls searchable text and media metadata (never the media itself) out of a message. */
export function extractContent(type: string, message: Json): { text: string | null; media: MediaMeta | null } {
  const body = isObject(message[type]) ? message[type] : {}

  if (MEDIA_TYPES.has(type)) {
    const media: MediaMeta = {}
    for (const key of ['id', 'mime_type', 'sha256', 'filename', 'caption'] as const) {
      const value = str(body[key])
      if (value) media[key] = value
    }
    if (typeof body.voice === 'boolean') media.voice = body.voice
    if (typeof body.animated === 'boolean') media.animated = body.animated
    return { text: str(body.caption), media }
  }

  switch (type) {
    case 'text':
      return { text: str(body.body), media: null }
    case 'reaction':
      return { text: str(body.emoji), media: null }
    case 'button':
      return { text: str(body.text), media: null }
    case 'interactive': {
      const reply = body.button_reply ?? body.list_reply ?? body.nfm_reply
      return { text: str(reply?.title) ?? str(reply?.body), media: null }
    }
    case 'location': {
      const parts = [str(body.name), str(body.address)].filter(Boolean)
      const coords = body.latitude != null && body.longitude != null ? `(${body.latitude}, ${body.longitude})` : null
      return { text: [...parts, coords].filter(Boolean).join(' ') || null, media: null }
    }
    case 'contacts': {
      const names = asArray(message.contacts).map((c) => {
        const phone = asArray(c.phones)[0]?.phone
        return [str(c.name?.formatted_name), str(phone)].filter(Boolean).join(' ')
      })
      return { text: names.filter(Boolean).join(', ') || null, media: null }
    }
    case 'order':
      return { text: str(body.text), media: null }
    case 'system':
      return { text: str(body.body), media: null }
    default:
      return { text: null, media: null }
  }
}
