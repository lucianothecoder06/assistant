import { Hono } from 'hono'
import type { AppDeps } from '../create-app.js'
import { drainPendingEvents, processEvent } from '../ingest/processor.js'
import { safeEqual, verifyMetaSignature } from '../whatsapp/signature.js'

export function webhookRoutes({ db, env, background }: AppDeps) {
  const routes = new Hono()

  // Meta's one-time subscription handshake.
  routes.get('/', (c) => {
    const mode = c.req.query('hub.mode')
    const token = c.req.query('hub.verify_token') ?? ''
    const challenge = c.req.query('hub.challenge') ?? ''
    if (mode === 'subscribe' && safeEqual(token, env.META_VERIFY_TOKEN)) {
      return c.text(challenge)
    }
    return c.text('forbidden', 403)
  })

  routes.post('/', async (c) => {
    const rawBody = new Uint8Array(await c.req.arrayBuffer())
    // Authenticate the exact bytes before touching the payload.
    if (!verifyMetaSignature(rawBody, c.req.header('x-hub-signature-256'), env.META_APP_SECRET)) {
      return c.text('invalid signature', 401)
    }

    let payload: unknown
    try {
      payload = JSON.parse(new TextDecoder().decode(rawBody))
    } catch {
      return c.text('invalid json', 400)
    }

    const { id } = await db
      .insertInto('webhook_events')
      .values({ payload: JSON.stringify(payload) })
      .returning('id')
      .executeTakeFirstOrThrow()

    // Acknowledge now; Meta retries (and eventually disables the webhook) on slow responses.
    background(
      processEvent(db, id)
        .then(() => drainPendingEvents(db))
        .catch((error: unknown) => {
          // Never log the payload: it contains message bodies.
          console.error('webhook processing failed', { eventId: id, error: error instanceof Error ? error.message : 'unknown' })
        }),
    )
    return c.text('EVENT_RECEIVED')
  })

  return routes
}
