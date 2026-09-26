// One-time, right after Coexistence onboarding: asks Meta to start the contacts and history sync.
// Read-only as far as WhatsApp goes: it sends no messages. Run it yourself; never from the server.
//
//   META_ACCESS_TOKEN=… META_PHONE_NUMBER_ID=… npm run whatsapp:sync
//
// Meta then delivers smb_app_state_sync and history webhooks to /webhooks/whatsapp.
import './load-env.js'

const token = process.env.META_ACCESS_TOKEN
const phoneNumberId = process.env.META_PHONE_NUMBER_ID
const version = process.env.META_GRAPH_VERSION ?? 'v23.0'

if (!token || !phoneNumberId) {
  console.error('Set META_ACCESS_TOKEN and META_PHONE_NUMBER_ID for this command.')
  process.exit(1)
}

for (const syncType of ['smb_app_state_sync', 'history'] as const) {
  const res = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/smb_app_data`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', sync_type: syncType }),
  })
  const body = await res.text()
  console.log(`${syncType}: HTTP ${res.status} ${body}`)
  if (!res.ok) process.exitCode = 1
}
