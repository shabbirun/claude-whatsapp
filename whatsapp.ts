#!/usr/bin/env bun

import { timingSafeEqual } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,  // used in Task 5: reply tool registration
  CallToolRequestSchema,   // used in Task 5: reply tool registration
} from '@modelcontextprotocol/sdk/types.js'

// --- Env validation (must run before anything else) ---
const REQUIRED = [
  'EVOLUTION_API_URL',
  'EVOLUTION_API_KEY',
  'EVOLUTION_INSTANCE',
  'ALLOWED_NUMBER',
  'EVOLUTION_WEBHOOK_SECRET',
] as const

for (const key of REQUIRED) {
  if (!process.env[key]?.trim()) {
    console.error(`[whatsapp] Missing required env var: ${key}`)
    process.exit(1)
  }
}

if (!/^\d+$/.test(process.env.ALLOWED_NUMBER!)) {
  console.error('[whatsapp] ALLOWED_NUMBER must be digits only (no + or spaces), e.g. 15551234567')
  process.exit(1)
}

const ENV = {
  apiUrl:         process.env.EVOLUTION_API_URL!,
  apiKey:         process.env.EVOLUTION_API_KEY!,
  instance:       process.env.EVOLUTION_INSTANCE!,
  allowedNumber:  process.env.ALLOWED_NUMBER!,
  webhookSecret:  process.env.EVOLUTION_WEBHOOK_SECRET!,
  webhookPort: (() => {
    const p = parseInt(process.env.WEBHOOK_PORT ?? '3456', 10)
    if (isNaN(p)) { console.error('[whatsapp] WEBHOOK_PORT must be a number'); process.exit(1) }
    return p
  })(),
} as const

console.error('[whatsapp] Env validated. Starting...')

// --- XML escape utility (prompt injection prevention) ---
function xmlEscape(str: string | null | undefined): string {
  if (!str) return ''
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// --- MCP server ---
const mcp = new Server(
  { name: 'whatsapp', version: '1.0.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },  // Claude Code channel extension
      tools: {},                                 // enables tool discovery
    },
    instructions:
      'You are a WhatsApp assistant. Messages arrive as <channel source="whatsapp" ' +
      'phone="..." instance="..." message_id="...">. When you receive a message, read it ' +
      'and respond helpfully. Use the reply tool to send your response back, passing the ' +
      'phone and instance from the tag. Be concise — this is a chat interface. Only one ' +
      'source is allowlisted; all messages are from the owner.',
  },
)

// --- Tool: list ---
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send a WhatsApp message back to the sender',
      inputSchema: {
        type: 'object' as const,
        properties: {
          phone: {
            type: 'string',
            description: 'Sender phone number from the <channel> tag (digits only, no +)',
          },
          instance: {
            type: 'string',
            description: 'Evolution API instance name from the <channel> tag',
          },
          text: {
            type: 'string',
            description: 'The message text to send',
          },
        },
        required: ['phone', 'instance', 'text'],
      },
    },
  ],
}))

// --- Tool: call ---
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'reply') {
    throw new Error(`Unknown tool: ${req.params.name}`)
  }

  const { phone, instance, text } = req.params.arguments as {
    phone: string
    instance: string
    text: string
  }

  // Validate arguments before use
  if (!phone || typeof phone !== 'string' ||
      !instance || typeof instance !== 'string' ||
      !text || typeof text !== 'string') {
    return {
      content: [{ type: 'text' as const, text: 'Invalid arguments: phone, instance, and text must be non-empty strings' }],
      isError: true,
    }
  }

  if (!/^\d+$/.test(phone)) {
    return {
      content: [{ type: 'text' as const, text: `Invalid phone: must be digits only (no +), got: ${phone}` }],
      isError: true,
    }
  }

  // Warn if instance doesn't match env (not an error — still send)
  if (instance !== ENV.instance) {
    console.error(
      `[whatsapp] Warning: reply instance "${instance}" doesn't match EVOLUTION_INSTANCE "${ENV.instance}"`,
    )
  }

  const url = `${ENV.apiUrl}/message/sendText/${instance}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: ENV.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ number: phone, text }),
    })

    if (!res.ok) {
      const body = (await res.text()).slice(0, 300)
      console.error(`[whatsapp] Reply failed: ${res.status} ${body}`)
      return {
        content: [{ type: 'text' as const, text: `Failed to send: ${res.status} ${body}` }],
        isError: true,
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[whatsapp] Network error sending reply: ${msg}`)
    return {
      content: [{ type: 'text' as const, text: `Network error: ${msg}` }],
      isError: true,
    }
  }

  console.error(`[whatsapp] Replied to ${phone} on ${instance}`)
  return { content: [{ type: 'text' as const, text: 'sent' }] }
})

// --- Connect to Claude Code ---
await mcp.connect(new StdioServerTransport())
console.error('[whatsapp] MCP server connected.')

// --- Webhook HTTP listener ---
Bun.serve({
  port: ENV.webhookPort,
  hostname: '127.0.0.1',
  async fetch(req) {
    // Only handle POST /webhook
    const url = new URL(req.url)
    if (req.method !== 'POST' || url.pathname !== '/webhook') {
      return new Response('not found', { status: 404 })
    }

    // 1. Verify webhook secret (timing-safe comparison)
    const incomingSecret = req.headers.get('apikey') ?? ''
    const secretsMatch = incomingSecret.length === ENV.webhookSecret.length &&
      timingSafeEqual(Buffer.from(incomingSecret), Buffer.from(ENV.webhookSecret))
    if (!secretsMatch) {
      console.error('[whatsapp] Webhook secret mismatch — dropping request')
      return new Response('ok')  // 200 to prevent retries
    }

    // 2. Parse payload
    let payload: any
    try {
      payload = await req.json()
    } catch {
      console.error('[whatsapp] Failed to parse webhook payload as JSON')
      return new Response('ok')
    }

    // 3. Only handle MESSAGES_UPSERT events
    if (payload.event !== 'messages.upsert') {
      return new Response('ok')
    }

    const data = payload.data
    if (!data?.key) {
      return new Response('ok')
    }

    // 4. Skip outbound echoes
    if (data.key.fromMe === true) {
      console.error('[whatsapp] Skipping outbound echo')
      return new Response('ok')
    }

    // 5. Extract and normalise sender
    const remoteJid: string = data.key.remoteJid ?? ''
    const senderPhone = remoteJid.replace('@s.whatsapp.net', '')

    // 6. Allowlist check
    if (senderPhone !== ENV.allowedNumber) {
      console.error(`[whatsapp] Dropping message from non-allowlisted sender: ${senderPhone}`)
      return new Response('ok')
    }

    // 7. Extract message text
    const messageText: string =
      data.message?.conversation ??
      data.message?.extendedTextMessage?.text ??
      '[unsupported message type]'

    const messageId: string = data.key.id ?? 'unknown'
    const instanceName: string = payload.instance ?? ENV.instance

    // 8. Warn on instance mismatch
    if (instanceName !== ENV.instance) {
      console.error(
        `[whatsapp] Warning: webhook instance "${instanceName}" doesn't match EVOLUTION_INSTANCE "${ENV.instance}"`,
      )
    }

    // 9. Emit channel notification
    console.error(`[whatsapp] Message from ${senderPhone}: ${messageText.slice(0, 60)}`)
    try {
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: xmlEscape(messageText),
          meta: {
            phone: senderPhone,
            instance: instanceName,
            message_id: messageId,
          },
        },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[whatsapp] Failed to emit notification: ${msg}`)
    }

    return new Response('ok')
  },
})

console.error(`[whatsapp] Webhook listener on http://127.0.0.1:${ENV.webhookPort}/webhook`)
