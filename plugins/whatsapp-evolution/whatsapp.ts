#!/usr/bin/env bun

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

// --- Load .env from PLUGIN_DATA (persists across updates) or cwd (dev mode) ---
// Bun auto-loads .env from cwd. In plugin mode we also check $PLUGIN_DATA.
const pluginDataDir = process.env.PLUGIN_DATA
if (pluginDataDir) {
  const envFile = Bun.file(`${pluginDataDir}/.env`)
  if (await envFile.exists()) {
    const lines = (await envFile.text()).split('\n')
    for (const line of lines) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq === -1) continue
      const key = t.slice(0, eq).trim()
      const val = t.slice(eq + 1).trim().replace(/^["'](.*)["']$/, '$1')
      if (key && !(key in process.env)) {
        process.env[key] = val
      }
    }
  }
}

// --- Env validation ---
const REQUIRED = [
  'EVOLUTION_API_URL',
  'EVOLUTION_API_KEY',
  'EVOLUTION_INSTANCE',
  'ALLOWED_NUMBER',
] as const

for (const key of REQUIRED) {
  if (!process.env[key]?.trim()) {
    console.error(`[whatsapp] Missing required env var: ${key}`)
    if (pluginDataDir) {
      console.error(`[whatsapp] Edit your config at: ${pluginDataDir}/.env`)
    }
    process.exit(1)
  }
}

if (!/^\d+$/.test(process.env.ALLOWED_NUMBER!)) {
  console.error('[whatsapp] ALLOWED_NUMBER must be digits only (no + or spaces), e.g. 15551234567')
  process.exit(1)
}

const ENV = {
  apiUrl:        process.env.EVOLUTION_API_URL!,
  apiKey:        process.env.EVOLUTION_API_KEY!,
  instance:      process.env.EVOLUTION_INSTANCE!,
  allowedNumber: process.env.ALLOWED_NUMBER!,
  allowedJid:    process.env.ALLOWED_JID ?? '',
  webhookPort: (() => {
    const p = parseInt(process.env.WEBHOOK_PORT ?? '3456', 10)
    if (isNaN(p)) { console.error('[whatsapp] WEBHOOK_PORT must be a number'); process.exit(1) }
    return p
  })(),
} as const

// --- XML escape (prompt injection prevention) ---
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
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions:
      'You are a WhatsApp assistant. Messages arrive as <channel source="whatsapp" ' +
      'instance="..." message_id="...">. When you receive a message, read it ' +
      'and respond helpfully. Use the reply tool to send your response back, passing the ' +
      'instance from the tag. Be concise — this is a chat interface. ' +
      'Only one source is allowlisted; all messages are from the owner.',
  },
)

// --- Tool: list ---
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send a WhatsApp message back to the owner',
      inputSchema: {
        type: 'object' as const,
        properties: {
          instance: {
            type: 'string',
            description: 'Evolution API instance name from the <channel> tag',
          },
          text: {
            type: 'string',
            description: 'The message text to send',
          },
        },
        required: ['instance', 'text'],
      },
    },
  ],
}))

// --- Tool: call ---
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'reply') {
    throw new Error(`Unknown tool: ${req.params.name}`)
  }

  const { instance, text } = req.params.arguments as { instance: string; text: string }

  if (!instance || typeof instance !== 'string' || !text || typeof text !== 'string') {
    return {
      content: [{ type: 'text' as const, text: 'Invalid arguments: instance and text must be non-empty strings' }],
      isError: true,
    }
  }

  const url = `${ENV.apiUrl}/message/sendText/${instance}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { apikey: ENV.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: ENV.allowedNumber, text }),
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
    console.error(`[whatsapp] Network error: ${msg}`)
    return {
      content: [{ type: 'text' as const, text: `Network error: ${msg}` }],
      isError: true,
    }
  }

  return { content: [{ type: 'text' as const, text: 'sent' }] }
})

// --- Connect to Claude Code ---
await mcp.connect(new StdioServerTransport())
console.error('[whatsapp] MCP connected.')

// --- Webhook HTTP listener ---
Bun.serve({
  port: ENV.webhookPort,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)
    if (req.method !== 'POST' || url.pathname !== '/webhook') {
      return new Response('not found', { status: 404 })
    }

    let payload: any
    try {
      payload = JSON.parse(await req.text())
    } catch {
      return new Response('ok')
    }

    // Handle both "MESSAGES_UPSERT" (v2) and "messages.upsert" (v1)
    const eventName = (payload.event ?? '').toLowerCase().replace(/_/g, '.')
    if (eventName !== 'messages.upsert') return new Response('ok')

    const data = payload.data
    if (!data?.key) return new Response('ok')
    if (data.key.fromMe === true) return new Response('ok')

    // Normalise JID: strips @s.whatsapp.net or @lid suffix
    const remoteJid: string = data.key.remoteJid ?? ''
    const senderId = remoteJid.split('@')[0]

    // Allowlist: accept phone number OR @lid identifier
    const isAllowed =
      senderId === ENV.allowedNumber ||
      (ENV.allowedJid !== '' && senderId === ENV.allowedJid)
    if (!isAllowed) {
      console.error(`[whatsapp] Blocked — add ALLOWED_JID=${senderId} to your .env and restart`)
      return new Response('ok')
    }

    const messageText: string =
      data.message?.conversation ??
      data.message?.extendedTextMessage?.text ??
      '[unsupported message type]'

    const messageId: string = data.key.id ?? 'unknown'
    const instanceName: string = payload.instance ?? ENV.instance

    try {
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: xmlEscape(messageText),
          meta: { instance: instanceName, message_id: messageId },
        },
      })
    } catch (err) {
      console.error(`[whatsapp] Failed to emit notification: ${err}`)
    }

    return new Response('ok')
  },
})

console.error(`[whatsapp] Webhook listening on http://127.0.0.1:${ENV.webhookPort}/webhook`)
