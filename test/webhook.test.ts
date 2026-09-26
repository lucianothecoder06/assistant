import { beforeEach, describe, expect, it } from 'vitest'
import { createTestApp, fixture, postWebhook, sign, TEST_ENV } from './helpers.js'

let ctx: Awaited<ReturnType<typeof createTestApp>>
beforeEach(async () => {
  ctx = await createTestApp()
})

const countEvents = async () => (await ctx.db.selectFrom('webhook_events').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n

describe('GET verification handshake', () => {
  it('echoes hub.challenge when the verify token matches', async () => {
    const res = await ctx.app.request(
      `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${TEST_ENV.META_VERIFY_TOKEN}&hub.challenge=1158201444`,
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('1158201444')
  })

  it('403s on a wrong or missing verify token', async () => {
    for (const query of ['hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1', 'hub.mode=subscribe&hub.challenge=1', '']) {
      const res = await ctx.app.request(`/webhooks/whatsapp?${query}`)
      expect(res.status).toBe(403)
    }
  })
})

describe('POST signature verification', () => {
  const body = fixture('messages-text.json')

  it('accepts a valid signature, stores the event and processes it', async () => {
    const res = await postWebhook(ctx.app, body)
    expect(res.status).toBe(200)
    await ctx.settle()
    expect(await countEvents()).toBe(1)
    const message = await ctx.db.selectFrom('messages').selectAll().executeTakeFirstOrThrow()
    expect(message.wamid).toBe('wamid.LIVE_IN_1')
  })

  it('rejects a missing signature', async () => {
    const res = await postWebhook(ctx.app, body, null)
    expect(res.status).toBe(401)
    expect(await countEvents()).toBe(0)
  })

  it('rejects a signature made with the wrong secret', async () => {
    const res = await postWebhook(ctx.app, body, sign(body, 'not-the-app-secret'))
    expect(res.status).toBe(401)
    expect(await countEvents()).toBe(0)
  })

  it('rejects a tampered body with the original signature', async () => {
    const tampered = body.replace('sofá de piel', 'sofá de tela')
    const res = await postWebhook(ctx.app, tampered, sign(body))
    expect(res.status).toBe(401)
    expect(await countEvents()).toBe(0)
  })

  it('rejects malformed signature headers', async () => {
    for (const header of ['', 'sha256=', 'sha1=abc', `sha256=${'z'.repeat(64)}`, sign(body).replace('sha256=', '')]) {
      const res = await postWebhook(ctx.app, body, header)
      expect(res.status).toBe(401)
    }
    expect(await countEvents()).toBe(0)
  })

  it('verifies the raw bytes, not a re-serialized JSON', async () => {
    // Same JSON, different whitespace: the signature must be over exactly what was sent.
    const reformatted = JSON.stringify(JSON.parse(body))
    expect(reformatted).not.toBe(body)
    expect((await postWebhook(ctx.app, reformatted, sign(body))).status).toBe(401)
    expect((await postWebhook(ctx.app, reformatted, sign(reformatted))).status).toBe(200)
  })

  it('400s on signed but invalid JSON without storing it', async () => {
    const res = await postWebhook(ctx.app, '{not json', sign('{not json'))
    expect(res.status).toBe(400)
    expect(await countEvents()).toBe(0)
  })
})

describe('cron drain', () => {
  it('requires the cron secret', async () => {
    expect((await ctx.app.request('/cron/drain')).status).toBe(401)
    expect((await ctx.app.request('/cron/drain', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
  })

  it('processes events left unprocessed', async () => {
    // Store an event without running the post-response processing, like a function killed mid-flight.
    await ctx.db.insertInto('webhook_events').values({ payload: fixture('messages-text.json') }).execute()
    const res = await ctx.app.request('/cron/drain', { headers: { authorization: `Bearer ${TEST_ENV.CRON_SECRET}` } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ processed: 1, failed: 0 })
    expect(await ctx.db.selectFrom('messages').select('wamid').execute()).toEqual([{ wamid: 'wamid.LIVE_IN_1' }])
  })
})

describe('privacy policy', () => {
  it('is public and bilingual', async () => {
    const res = await ctx.app.request('/privacy')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Aviso de privacidad')
    expect(body).toContain('Privacy policy')
  })
})
