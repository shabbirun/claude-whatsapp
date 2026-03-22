# WhatsApp Claude Code Channel — Design Spec

**Date:** 2026-03-22
**Status:** Approved

## Overview

A Claude Code channel that bridges WhatsApp (via Evolution API) into a Claude Code session. Incoming WhatsApp messages are forwarded to Claude as channel events; Claude replies autonomously using a two-way reply tool. Only the owner's number is allowlisted.

## Architecture & Data Flow

```
WhatsApp user sends message
        ↓
Evolution API (self-hosted, ngrok-exposed at https://rema-noted-judie.ngrok-free.dev)
        ↓  POST /webhook (localhost:3456)
whatsapp.ts HTTP listener
        ↓  allowlist check — drop if sender ≠ ALLOWED_NUMBER
MCP notification → Claude Code
        ↓  <channel source="whatsapp" ...> tag injected into context
Claude reads message, thinks, calls reply tool
        ↓  reply({ instance, phone, text })
Evolution API REST  POST /message/sendText/{instance}
        ↓
WhatsApp delivers reply
```

## Components

### whatsapp.ts (single file)

1. **MCP Server** — declares `claude/channel` + `tools: {}` capabilities. Sets `instructions` in system prompt.
2. **HTTP webhook listener** — Bun HTTP server on `localhost:3456`. Receives Evolution API POST events at `/webhook`.
3. **Allowlist gate** — reads `ALLOWED_NUMBER` from env. Silently drops any event whose sender does not match before emitting a notification.
4. **`reply` MCP tool** — called by Claude to send a WhatsApp message back via Evolution API.
5. **Stdio transport** — connects to Claude Code via `StdioServerTransport` (Claude Code spawns the process).

### .mcp.json

Registers the channel server so Claude Code spawns it at startup:

```json
{
  "mcpServers": {
    "whatsapp": { "command": "bun", "args": ["./whatsapp.ts"] }
  }
}
```

## Notification Format

Each inbound WhatsApp message is emitted as:

```ts
mcp.notification({
  method: 'notifications/claude/channel',
  params: {
    content: messageText,
    meta: {
      phone: senderNumber,      // E.164 without +, e.g. "15551234567"
      instance: instanceName,   // Evolution API instance
      message_id: messageId,    // for deduplication if needed
    },
  },
})
```

Claude receives it as:

```xml
<channel source="whatsapp" phone="15551234567" instance="my-instance" message_id="ABC123">
Hey Claude, what's on my calendar today?
</channel>
```

## Reply Tool

```ts
{
  name: 'reply',
  description: 'Send a WhatsApp message back to the sender',
  inputSchema: {
    type: 'object',
    properties: {
      phone:    { type: 'string', description: 'Sender phone from the <channel> tag' },
      instance: { type: 'string', description: 'Evolution API instance from the <channel> tag' },
      text:     { type: 'string', description: 'Message text to send' },
    },
    required: ['phone', 'instance', 'text'],
  },
}
```

Calls: `POST {EVOLUTION_API_URL}/message/sendText/{instance}` with headers `apikey: {EVOLUTION_API_KEY}` and body `{ number: phone, text }`.

## Claude Instructions (system prompt addition)

> You are a WhatsApp assistant. Messages arrive as `<channel source="whatsapp" phone="..." instance="..." message_id="...">`. When you receive a message, read it and respond helpfully. Use the `reply` tool to send your response back, passing the `phone` and `instance` from the tag. Be concise — this is a chat interface. Only one source is allowlisted; all messages are from the owner.

## Configuration (.env)

| Variable | Description | Example |
|---|---|---|
| `EVOLUTION_API_URL` | Base URL of Evolution API | `https://rema-noted-judie.ngrok-free.dev` |
| `EVOLUTION_API_KEY` | Evolution API key | `your-api-key` |
| `ALLOWED_NUMBER` | Owner's number, E.164 no `+` | `15551234567` |
| `EVOLUTION_INSTANCE` | Evolution API instance name | `my-instance` |
| `WEBHOOK_PORT` | Local port for webhook listener | `3456` |

## File Structure

```
claude-whatsapp/
├── whatsapp.ts       # complete channel server
├── .env              # secrets (gitignored)
├── .env.example      # committed template
├── .mcp.json         # Claude Code MCP registration
├── package.json      # bun project + @modelcontextprotocol/sdk
└── .gitignore
```

## Evolution API Webhook Setup

Configure your Evolution API instance webhook to:
- **URL:** `http://localhost:3456/webhook`
- **Events:** `MESSAGES_UPSERT` (or equivalent for new messages)

No ngrok needed for the webhook — Evolution API and this server both run locally.

## Starting the Channel

```bash
claude --dangerously-load-development-channels server:whatsapp
```

Claude Code reads `.mcp.json`, spawns `whatsapp.ts` as a subprocess, and the webhook listener starts automatically.

## Security

- Allowlist gates on **sender identity** (`phone` from message payload), not chat/group ID
- All secrets in `.env`, never committed
- Webhook listener bound to `127.0.0.1` only
