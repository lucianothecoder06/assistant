import type { Direction, MediaMeta, MessageSource } from '../db/schema.js'

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
  raw: unknown
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

export function normalizeWebhook(_payload: unknown): NormalizedEvent[] {
  return []
}
