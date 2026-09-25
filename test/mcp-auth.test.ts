import { SignJWT } from 'jose'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { upsertOwner } from '../src/auth/owner.js'
import { OWNER_PASSWORD, startTestServer, TEST_ENV } from './helpers.js'
import { INITIALIZE, mcpRequest, runOAuthFlow } from './oauth-flow.js'

let ctx: Awaited<ReturnType<typeof startTestServer>>

beforeAll(async () => {
  ctx = await startTestServer()
  await upsertOwner(ctx.auth, TEST_ENV.OWNER_EMAIL, OWNER_PASSWORD)
})
afterAll(() => ctx.close())

const owner = { email: TEST_ENV.OWNER_EMAIL, password: OWNER_PASSWORD }
const LIST_TOOLS = { jsonrpc: '2.0', id: 2, method: 'tools/list' }

describe('MCP rejects unauthenticated requests', () => {
  it('401s with an RFC 9728 challenge when no token is sent', async () => {
    const res = await mcpRequest(ctx.baseUrl, LIST_TOOLS)
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain(
      `resource_metadata="${ctx.baseUrl}/.well-known/oauth-protected-resource/mcp"`,
    )
  })

  it('401s for a garbage bearer token', async () => {
    const res = await mcpRequest(ctx.baseUrl, LIST_TOOLS, 'not-a-real-token')
    expect(res.status).toBe(401)
  })

  it('401s for a JWT signed with someone else\'s key', async () => {
    const forged = await new SignJWT({ sub: 'x', aud: `${ctx.baseUrl}/mcp` })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(`${ctx.baseUrl}/api/auth`)
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(TEST_ENV.BETTER_AUTH_SECRET))
    const res = await mcpRequest(ctx.baseUrl, LIST_TOOLS, forged)
    expect(res.status).toBe(401)
  })

  it('does not let GET or DELETE through without a token either', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${ctx.baseUrl}/mcp`, { method })
      expect(res.status).toBe(401)
    }
  })
})

describe('discovery', () => {
  it('publishes protected-resource and authorization-server metadata', async () => {
    const prm = await (await fetch(`${ctx.baseUrl}/.well-known/oauth-protected-resource/mcp`)).json()
    expect(prm.resource).toBe(`${ctx.baseUrl}/mcp`)
    expect(prm.authorization_servers).toEqual([`${ctx.baseUrl}/api/auth`])

    const as = await (await fetch(`${ctx.baseUrl}/.well-known/oauth-authorization-server/api/auth`)).json()
    expect(as.issuer).toBe(`${ctx.baseUrl}/api/auth`)
    expect(as.code_challenge_methods_supported).toContain('S256')
    expect(as.registration_endpoint).toBe(`${ctx.baseUrl}/api/auth/oauth2/register`)
  })
})

describe('owner-only access', () => {
  it('lets the owner complete the OAuth flow and call tools', async () => {
    const flow = await runOAuthFlow(ctx.baseUrl, owner)
    expect(flow.ok).toBe(true)
    if (!flow.ok) return
    expect(flow.tokens.access_token).toBeTruthy()

    const init = await mcpRequest(ctx.baseUrl, INITIALIZE, flow.tokens.access_token)
    expect(init.status).toBe(200)

    const tools = await (await mcpRequest(ctx.baseUrl, LIST_TOOLS, flow.tokens.access_token)).json()
    expect(tools.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      'find_contact',
      'get_conversation',
      'list_chats',
      'list_unanswered',
      'search_messages',
    ])
  })

  it('rejects a wrong password', async () => {
    const flow = await runOAuthFlow(ctx.baseUrl, { ...owner, password: 'wrong password 123' }, { ip: '203.0.113.2' })
    expect(flow.ok).toBe(false)
  })

  it('rate-limits password guessing', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${ctx.baseUrl}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7' },
        body: JSON.stringify({ email: TEST_ENV.OWNER_EMAIL, password: `guess number ${i}` }),
      })
      statuses.push(res.status)
    }
    expect(statuses).toContain(429)
  })

  it('refuses sign-ups, even for the owner email', async () => {
    for (const email of ['intruder@example.com', TEST_ENV.OWNER_EMAIL]) {
      const res = await fetch(`${ctx.baseUrl}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'some long password', name: 'x' }),
      })
      expect(res.ok).toBe(false)
    }
  })

  it('blocks creating any user row other than the owner', async () => {
    const authCtx = await ctx.auth.$context
    await expect(
      authCtx.internalAdapter.createUser({ email: 'second@example.com', name: 'x', emailVerified: true }, { method: 'admin' }),
    ).rejects.toThrow()
  })

  it('403s a validly-issued token whose subject is not the owner', async () => {
    // Simulate a second account that bypassed every lock (inserted straight into the DB).
    const authCtx = await ctx.auth.$context
    const hash = await authCtx.password.hash('another long password')
    await sql`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
              values ('intruder', 'x', 'intruder@example.com', true, now(), now())`.execute(ctx.db)
    await sql`insert into account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
              values ('intruder-acc', 'intruder', 'credential', 'intruder', ${hash}, now(), now())`.execute(ctx.db)

    const flow = await runOAuthFlow(ctx.baseUrl, { email: 'intruder@example.com', password: 'another long password' }, { ip: '203.0.113.3' })
    expect(flow.ok).toBe(true)
    if (!flow.ok) return
    const res = await mcpRequest(ctx.baseUrl, LIST_TOOLS, flow.tokens.access_token)
    expect(res.status).toBe(403)
  })

  it('still issues an MCP-bound token when the client omits the resource parameter', async () => {
    const flow = await runOAuthFlow(ctx.baseUrl, owner, { sendResource: false, ip: '203.0.113.9' })
    expect(flow.ok ? 'ok' : flow.status).toBe('ok')
    if (!flow.ok) return
    const res = await mcpRequest(ctx.baseUrl, INITIALIZE, flow.tokens.access_token)
    expect(res.status).toBe(200)
  })

  it('refreshes tokens, and the documented revocation stops refreshes', async () => {
    const flow = await runOAuthFlow(ctx.baseUrl, owner, { ip: '203.0.113.20' })
    if (!flow.ok) throw new Error('flow failed')
    expect(flow.tokens.refresh_token).toBeTruthy()

    const refresh = () =>
      fetch(`${ctx.baseUrl}/api/auth/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: flow.tokens.refresh_token!, client_id: flow.client.client_id }),
      })
    const refreshed = await refresh()
    expect(refreshed.status).toBe(200)
    const next = await refreshed.json()
    expect((await mcpRequest(ctx.baseUrl, INITIALIZE, next.access_token)).status).toBe(200)

    await sql`delete from "oauthClient"`.execute(ctx.db)
    await sql`delete from session`.execute(ctx.db)
    const afterRevoke = await fetch(`${ctx.baseUrl}/api/auth/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: next.refresh_token, client_id: flow.client.client_id }),
    })
    expect(afterRevoke.ok).toBe(false)
  })
})
