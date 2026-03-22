#!/usr/bin/env bun

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
function xmlEscape(str: string): string {
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

// --- Connect to Claude Code ---
await mcp.connect(new StdioServerTransport())
console.error('[whatsapp] MCP server connected.')
