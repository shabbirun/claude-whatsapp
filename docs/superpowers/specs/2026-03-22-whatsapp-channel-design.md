# WhatsApp Claude Code Channel — Design Spec

**Date:** 2026-03-22
**Status:** Approved

## Overview

A Claude Code channel that bridges WhatsApp (via Evolution API) into a Claude Code session. Incoming WhatsApp messages are forwarded to Claude as channel events; Claude replies autonomously using a two-way reply tool. Only the owner's number is allowlisted.

## Architecture & Data Flow

```
WhatsApp user sends message
        ↓
Evolution API (self-hosted, locally at e.g. http://localhost:8080)
        ↓  POST /webhook (localhost:3456)
whatsapp.ts HTTP listener
        ↓  verify webhook secret (drop if invalid)
        ↓  allowlist check (drop if sender ≠ ALLOWED_NUMBER)
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

1. **MCP Server** — declares the `claude/channel` Claude Code proprietary capability extension (see Capability Declaration below) plus `tools: {}`. Sets `instructions` in system prompt.
2. **HTTP webhook listener** — Bun HTTP server on `localhost:3456`, bound to `127.0.0.1`. Receives Evolution API POST events at `/webhook`.
3. **Webhook signature verification** — validates `EVOLUTION_WEBHOOK_SECRET` against the `apikey` header sent by Evolution API on every request before reading the payload. Returns `200 OK` on drop (to prevent Evolution API retries).
4. **Allowlist gate** — reads `ALLOWED_NUMBER` from env. Compares against `data.key.remoteJid` (stripped of `@s.whatsapp.net` suffix) from the `MESSAGES_UPSERT` payload. Silently drops and returns `200 OK` for non-matching senders.
5. **`reply` MCP tool** — called by Claude to send a WhatsApp message back via Evolution API.
6. **Startup validation** — on boot, checks that all required env vars are present and non-empty; exits with a clear error message if any are missing.
7. **Stdio transport** — connects to Claude Code via `StdioServerTransport` (Claude Code spawns the process).

### .mcp.json

Registers the channel server so Claude Code spawns it at startup:

```json
{
  "mcpServers": {
    "whatsapp": { "command": "bun", "args": ["./whatsapp.ts"] }
  }
}
```

## Capability Declaration

`claude/channel` is a Claude Code proprietary extension to the MCP protocol (not part of the published MCP spec). It is declared in the `capabilities.experimental` object of the MCP `Server` constructor:

```ts
const mcp = new Server(
  { name: 'whatsapp', version: '1.0.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },  // Claude Code channel extension
      tools: {},                                 // enables tool discovery
    },
    instructions: '...',  // added to Claude's system prompt
  },
)
```

This causes Claude Code to register a notification listener for `notifications/claude/channel` events — also a Claude Code proprietary extension method, not standard MCP.

## Notification Format

Each inbound WhatsApp message is emitted as:

```ts
await mcp.notification({
  method: 'notifications/claude/channel',
  params: {
    content: xmlEscape(messageText),  // content must be XML-escaped
    meta: {
      phone: senderNumber,      // E.164 digits only, no +, e.g. "15551234567"
      instance: instanceName,   // Evolution API instance name
      message_id: messageId,    // for reference; no deduplication in v1
    },
  },
})
```

`xmlEscape` must replace at minimum: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, `"` → `&quot;`, `'` → `&apos;`. This prevents prompt injection via crafted message content.

Claude receives it as:

```xml
<channel source="whatsapp" phone="15551234567" instance="my-instance" message_id="ABC123">
Hey Claude, what&apos;s on my calendar today?
</channel>
```

### Evolution API Payload — Sender Field

For `MESSAGES_UPSERT` events, the sender is at `data.key.remoteJid`. This value is in the format `15551234567@s.whatsapp.net`; strip the `@s.whatsapp.net` suffix before comparing to `ALLOWED_NUMBER`.

Only process messages where `data.key.fromMe === false` (i.e., incoming messages, not echoes of outbound sends).

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

**Evolution API call:**
```
POST {EVOLUTION_API_URL}/message/sendText/{instance}
Headers: { apikey: EVOLUTION_API_KEY, 'Content-Type': 'application/json' }
Body:    { number: phone, text: text }
```

The `number` field must be E.164 digits only (no `+`, no spaces) — e.g. `"15551234567"`.

**Error handling:** if Evolution API returns a non-2xx status, the tool handler must return an MCP error result (e.g. `{ content: [{ type: 'text', text: 'Failed to send: <status> <body>' }], isError: true }`) so Claude knows the send failed and can inform the user.

## Claude Instructions (system prompt addition)

> You are a WhatsApp assistant. Messages arrive as `<channel source="whatsapp" phone="..." instance="..." message_id="...">`. When you receive a message, read it and respond helpfully. Use the `reply` tool to send your response back, passing the `phone` and `instance` from the tag. Be concise — this is a chat interface. Only one source is allowlisted; all messages are from the owner.

## Configuration (.env)

| Variable | Description | Example |
|---|---|---|
| `EVOLUTION_API_URL` | Base URL of locally-running Evolution API | `http://localhost:8080` |
| `EVOLUTION_API_KEY` | Evolution API key | `your-api-key` |
| `EVOLUTION_INSTANCE` | Evolution API instance name (used in reply calls and for validation) | `my-instance` |
| `ALLOWED_NUMBER` | Owner's number, E.164 digits only (no `+`) | `15551234567` |
| `EVOLUTION_WEBHOOK_SECRET` | Shared secret set in Evolution API webhook config | `your-webhook-secret` |
| `WEBHOOK_PORT` | Local port for webhook listener | `3456` |

`.env.example` must be committed and contain all keys from this table with placeholder values (no real secrets).

**Note on `EVOLUTION_API_URL`:** Use the local URL (e.g. `http://localhost:8080`) for the Evolution API. The ngrok URL is for exposing Evolution API to WhatsApp's infrastructure — it is not used by this server. Reply calls go directly localhost-to-localhost.

**`EVOLUTION_INSTANCE`** is used in outbound `reply` calls as a default/validation. The `instance` value in the `<channel>` tag comes from the inbound webhook payload and should match this env var; a mismatch should be logged as a warning.

## File Structure

```
claude-whatsapp/
├── whatsapp.ts       # complete channel server
├── .env              # secrets (gitignored)
├── .env.example      # committed template with placeholder values
├── .mcp.json         # Claude Code MCP registration
├── package.json      # bun project, pins @modelcontextprotocol/sdk version
└── .gitignore
```

**Runtime requirement:** Bun v1.1.0 or later.
**SDK version:** Pin `@modelcontextprotocol/sdk` to `^1.0.0` (or latest stable at time of implementation) in `package.json`.

## Startup Validation

On process start, before connecting to stdio, validate:
- `EVOLUTION_API_URL` — present and non-empty
- `EVOLUTION_API_KEY` — present and non-empty
- `ALLOWED_NUMBER` — present, non-empty, digits only
- `EVOLUTION_WEBHOOK_SECRET` — present and non-empty
- `EVOLUTION_INSTANCE` — present and non-empty
- `WEBHOOK_PORT` — defaults to `3456` if absent; no validation required

If any are missing: log a descriptive error to `stderr` and `process.exit(1)`.

## Evolution API Webhook Setup

In your Evolution API webhook config, set:
- **URL:** `http://localhost:3456/webhook`
- **Events:** `MESSAGES_UPSERT`
- **Secret/Token:** match `EVOLUTION_WEBHOOK_SECRET` in your `.env`

No ngrok needed for the webhook — Evolution API and this server both run locally.

## Starting the Channel

Claude Code reads `.mcp.json` on startup and spawns `whatsapp.ts` automatically. The `--dangerously-load-development-channels` flag bypasses the Claude Code channel allowlist (required during research preview for custom/unregistered channels):

```bash
claude --dangerously-load-development-channels server:whatsapp
```

## Security

- **Webhook secret** — every inbound request validated against `EVOLUTION_WEBHOOK_SECRET` before payload is read
- **Allowlist** — gates on `data.key.remoteJid` (sender identity), not chat/group ID; drops non-matching senders with `200 OK`
- **XML escaping** — message content is escaped before injection into the `<channel>` tag to prevent prompt injection
- **Localhost binding** — webhook listener bound to `127.0.0.1` only
- **No outbound ngrok** — reply calls go directly to `http://localhost:8080`, never over the public internet
- **Secrets in `.env`** — never committed; `.env.example` committed with placeholders
