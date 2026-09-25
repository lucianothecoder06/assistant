import { createHash, randomBytes } from 'node:crypto'

export const CLAUDE_REDIRECT = 'https://claude.ai/api/mcp/auth_callback'

const json = { 'content-type': 'application/json', accept: 'application/json' }

/** Drives the same OAuth 2.1 flow claude.ai runs: register → authorize (PKCE) → sign in → consent → token. */
export async function runOAuthFlow(
  base: string,
  credentials: { email: string; password: string },
  options: { sendResource?: boolean; ip?: string } = {},
) {
  const registration = await fetch(`${base}/api/auth/oauth2/register`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({
      client_name: 'Claude',
      redirect_uris: [CLAUDE_REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  })
  if (registration.status !== 201) throw new Error(`register failed: ${registration.status}`)
  const client = (await registration.json()) as { client_id: string }

  const verifier = randomBytes(32).toString('base64url')
  const authorize = new URL(`${base}/api/auth/oauth2/authorize`)
  const params: Record<string, string> = {
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: CLAUDE_REDIRECT,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'state-123',
    scope: 'openid offline_access',
  }
  if (options.sendResource !== false) params.resource = `${base}/mcp`
  for (const [key, value] of Object.entries(params)) authorize.searchParams.set(key, value)

  const authorizeRes = await fetch(authorize, { headers: { accept: 'application/json' }, redirect: 'manual' })
  const loginUrl = new URL(authorizeRes.headers.get('location') ?? ((await authorizeRes.json()) as { url: string }).url, base)

  const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
    method: 'POST',
    // Distinct client IPs keep tests from tripping the sign-in rate limit on each other.
    headers: { ...json, 'x-forwarded-for': options.ip ?? '203.0.113.1' },
    body: JSON.stringify({ ...credentials, oauth_query: loginUrl.search.slice(1) }),
  })
  if (!signIn.ok) return { ok: false as const, status: signIn.status, client }
  const cookie = signIn.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
  let next = new URL(((await signIn.json()) as { url: string }).url, base)

  if (next.pathname === '/consent') {
    const consentPage = await fetch(next, { headers: { cookie } })
    const consent = await fetch(`${base}/api/auth/oauth2/consent`, {
      method: 'POST',
      headers: { ...json, cookie },
      body: JSON.stringify({ accept: true, oauth_query: next.search.slice(1) }),
    })
    const body = (await consent.json()) as { url?: string; redirect_uri?: string }
    next = new URL((body.url ?? body.redirect_uri)!)
    void consentPage
  }

  if (next.searchParams.get('state') !== 'state-123') throw new Error('state not echoed')
  const code = next.searchParams.get('code')
  if (!code) throw new Error(`no code in redirect: ${next.search}`)

  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: CLAUDE_REDIRECT,
    client_id: client.client_id,
    code_verifier: verifier,
  })
  if (options.sendResource !== false) tokenBody.set('resource', `${base}/mcp`)
  const token = await fetch(`${base}/api/auth/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: tokenBody,
  })
  const tokens = (await token.json()) as { access_token?: string; refresh_token?: string; error?: string }
  return { ok: true as const, status: token.status, client, tokens, verifier }
}

export function mcpRequest(base: string, body: unknown, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  if (token) headers.authorization = `Bearer ${token}`
  return fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) })
}

export const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
}
