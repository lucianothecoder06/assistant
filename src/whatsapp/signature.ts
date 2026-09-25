import { createHmac, timingSafeEqual } from 'node:crypto'

const PREFIX = 'sha256='

/**
 * Verifies Meta's `X-Hub-Signature-256` header: `sha256=` + hex HMAC-SHA256 of the raw
 * request body keyed with the app secret. Must run on the exact bytes received, before parsing.
 */
export function verifyMetaSignature(rawBody: Uint8Array, header: string | undefined, appSecret: string): boolean {
  if (!header || !header.startsWith(PREFIX)) return false
  const received = Buffer.from(header.slice(PREFIX.length), 'hex')
  const expected = createHmac('sha256', appSecret).update(rawBody).digest()
  // A malformed hex string decodes short; the length check keeps timingSafeEqual from throwing.
  return received.length === expected.length && timingSafeEqual(received, expected)
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
