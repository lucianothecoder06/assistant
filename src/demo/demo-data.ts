/**
 * Fake but realistic WhatsApp Business traffic for trying the service end to end before a real
 * number is connected. Every demo phone number starts with DEMO_PREFIX so it can be removed cleanly.
 */
export const DEMO_PREFIX = '52155500000'
const BUSINESS_NUMBER = '15550001111'
const PHONE_NUMBER_ID = '100000000000001'

interface DemoContact {
  waId: string
  savedName: string | null
  profileName: string
}

type Line = [contact: number, from: 'contact' | 'me', minutesAgo: number, text: string]

const contacts: DemoContact[] = [
  { waId: `${DEMO_PREFIX}1`, savedName: 'María José Hernández', profileName: 'Majo' },
  { waId: `${DEMO_PREFIX}2`, savedName: 'Jorge Ramírez (Mesas)', profileName: 'Jorge R' },
  { waId: `${DEMO_PREFIX}3`, savedName: 'Ana Lucía Torres', profileName: 'Ana Lu' },
  { waId: `${DEMO_PREFIX}4`, savedName: 'Carlos Méndez', profileName: 'Carlos' },
  { waId: `${DEMO_PREFIX}5`, savedName: 'Sofía Guzmán', profileName: 'Sofi G' },
  { waId: `${DEMO_PREFIX}6`, savedName: 'Roberto Díaz – Maderas del Norte', profileName: 'Roberto Díaz' },
  { waId: `${DEMO_PREFIX}7`, savedName: 'Fernanda Ruiz', profileName: 'Fer' },
  // Not in the address book: only their own WhatsApp profile name is known.
  { waId: `${DEMO_PREFIX}8`, savedName: null, profileName: 'Luis Ángel' },
]

const H = 60
const D = 24 * H

const lines: Line[] = [
  // María José: sofa quote, she asked a follow-up 6h ago → unanswered.
  [0, 'contact', 20 * D, 'Hola, buenas tardes. ¿Tienen sofás de piel de tres plazas?'],
  [0, 'me', 20 * D - 30, '¡Hola María José! Sí, tenemos el modelo Oslo en piel color coñac y negro. ¿Te mando fotos?'],
  [0, 'contact', 20 * D - 45, 'Sí porfa, y el precio'],
  [0, 'me', 20 * D - 60, 'El Oslo de tres plazas está en $18,900 con envío incluido en CDMX.'],
  [0, 'contact', 2 * D, 'Hola de nuevo, ya lo platiqué con mi esposo. ¿Me puedes mandar la cotización formal con factura?'],
  [0, 'me', 2 * D - 20, 'Claro, te la mando hoy en la tarde.'],
  [0, 'contact', 6 * H, 'Hola, ¿pudiste enviar la cotización? Quiero apartarlo esta semana.'],

  // Jorge: table catalog, answered, closed.
  [1, 'contact', 12 * D, '¿Me pueden mandar el catálogo de mesas de comedor?'],
  [1, 'me', 12 * D - 15, 'Claro Jorge, aquí va el catálogo 2026. Las de parota están en promoción este mes.'],
  [1, 'contact', 12 * D - 40, 'Gracias, me interesa la mesa de parota para 8 personas. ¿Cuánto tarda la entrega?'],
  [1, 'me', 12 * D - 50, 'La de 8 personas tarda 3 semanas porque se hace sobre pedido. Anticipo del 50%.'],
  [1, 'contact', 11 * D, 'Perfecto, ya hice la transferencia del anticipo.'],
  [1, 'me', 11 * D - 10, 'Recibido, gracias Jorge. Te aviso cuando esté lista.'],

  // Ana Lucía: delivery date, waiting 2 days → unanswered.
  [2, 'contact', 9 * D, 'Hola, compré una cómoda la semana pasada, pedido 4821.'],
  [2, 'me', 9 * D - 25, 'Hola Ana Lucía, sí la tengo registrada. Sale a reparto el jueves.'],
  [2, 'contact', 2 * D + 3 * H, 'Hola, no llegó el jueves. ¿Me pueden decir cuándo la entregan? Necesito estar en casa.'],

  // Carlos: invoice, I answered last.
  [3, 'contact', 5 * D, 'Buenas, necesito factura de mi compra del sábado. RFC MECC850101AB1'],
  [3, 'me', 5 * D - 20, 'Con gusto Carlos, ¿me confirmas tu correo y el uso de CFDI?'],
  [3, 'contact', 5 * D - 35, 'carlos.mendez@example.com, uso G03 gastos en general'],
  [3, 'me', 4 * D, 'Listo, ya te llegó la factura al correo. Cualquier cosa me avisas.'],

  // Sofía: damaged item 30 min ago → waiting, but under 4h.
  [4, 'contact', 30 * D, '¿Hacen envíos a Querétaro?'],
  [4, 'me', 30 * D - 60, 'Sí, enviamos a todo México. El envío a Querétaro cuesta $350.'],
  [4, 'contact', 3 * D, 'Ya me llegó el librero, muchas gracias.'],
  [4, 'contact', 30, 'Oye, revisando bien el librero tiene un rayón en la parte de arriba. ¿Qué podemos hacer?'],

  // Roberto (supplier): I asked, waiting on him.
  [5, 'me', 15 * D, 'Roberto, ¿cuándo me puedes surtir 20 tablones de parota?'],
  [5, 'contact', 15 * D - 120, 'La próxima semana te los mando. Mismo precio que la vez pasada.'],
  [5, 'me', 1 * D, '¿Todavía tienes parota? Necesito otros 10 tablones para un pedido de mesa.'],

  // Fernanda: old history, quote went cold.
  [6, 'contact', 60 * D, 'Hola, ¿cuánto cuesta un comedor de 6 sillas?'],
  [6, 'me', 60 * D - 30, 'Hola Fernanda, el comedor Nórdico de 6 sillas está en $24,500.'],
  [6, 'contact', 60 * D - 90, 'Ok gracias, lo pienso y te aviso.'],

  // Luis Ángel: unknown number, asked 5h ago → unanswered.
  [7, 'contact', 5 * H, 'Buenas, vi su anuncio en Instagram. ¿Tienen recámaras completas? ¿Aceptan meses sin intereses?'],
]

const HISTORY_CUTOFF_MINUTES = 3 * D

function envelope(field: string, value: Record<string, unknown>) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '100000000000000',
        changes: [
          {
            field,
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: BUSINESS_NUMBER, phone_number_id: PHONE_NUMBER_ID },
              ...value,
            },
          },
        ],
      },
    ],
  }
}

/** Builds the webhook payloads Meta would send: contacts sync, a history chunk, live messages and echoes. */
export function buildDemoPayloads(now = new Date()): object[] {
  const ts = (minutesAgo: number) => String(Math.floor((now.getTime() - minutesAgo * 60_000) / 1000))
  const wamid = (i: number) => `wamid.DEMO_${String(i).padStart(3, '0')}`
  const indexed = lines.map((line, i) => ({ line, id: wamid(i + 1) }))

  const stateSync = envelope('smb_app_state_sync', {
    state_sync: contacts
      .filter((c) => c.savedName)
      .map((c) => ({
        type: 'contact',
        contact: { full_name: c.savedName, first_name: c.savedName!.split(' ')[0], phone_number: c.waId },
        action: 'add',
        metadata: { timestamp: ts(0) },
      })),
  })

  const threads = contacts
    .map((contact, ci) => ({
      id: contact.waId,
      messages: indexed
        .filter(({ line }) => line[0] === ci && line[2] >= HISTORY_CUTOFF_MINUTES)
        .map(({ line: [, from, ago, text], id }) => ({
          from: from === 'contact' ? contact.waId : BUSINESS_NUMBER,
          ...(from === 'me' ? { to: contact.waId } : {}),
          id,
          timestamp: ts(ago),
          type: 'text',
          text: { body: text },
          history_context: { status: 'READ' },
        })),
    }))
    .filter((thread) => thread.messages.length > 0)

  const history = envelope('history', {
    history: [{ metadata: { phase: 0, chunk_order: 1, progress: 100 }, threads }],
  })

  const live = indexed
    .filter(({ line }) => line[2] < HISTORY_CUTOFF_MINUTES)
    .map(({ line: [ci, from, ago, text], id }) => {
      const contact = contacts[ci]!
      const message = { id, timestamp: ts(ago), type: 'text', text: { body: text } }
      return from === 'contact'
        ? envelope('messages', {
            contacts: [{ profile: { name: contact.profileName }, wa_id: contact.waId }],
            messages: [{ from: contact.waId, ...message }],
          })
        : envelope('smb_message_echoes', { message_echoes: [{ from: BUSINESS_NUMBER, to: contact.waId, ...message }] })
    })

  // Read receipts for the recent replies.
  const statuses = envelope('messages', {
    statuses: indexed
      .filter(({ line }) => line[1] === 'me' && line[2] < HISTORY_CUTOFF_MINUTES)
      .map(({ line, id }) => ({ id, status: 'read', timestamp: ts(line[2] - 5), recipient_id: contacts[line[0]]!.waId })),
  })

  return [stateSync, history, ...live, statuses]
}

export const DEMO_SUMMARY = { contacts: contacts.length, messages: lines.length }
