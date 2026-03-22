# WhatsApp Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-file Bun MCP channel server that bridges WhatsApp (via Evolution API) into Claude Code with two-way messaging and owner-only allowlisting.

**Architecture:** A Bun process (`whatsapp.ts`) connects to Claude Code over stdio as an MCP server, declares the `claude/channel` capability, and starts a local HTTP server on port 3456 to receive Evolution API webhooks. Inbound messages are XML-escaped and emitted as `notifications/claude/channel` events; Claude replies via a `reply` MCP tool that POSTs to the local Evolution API.

**Tech Stack:** Bun v1.1.0+, `@modelcontextprotocol/sdk` (latest stable), Evolution API (self-hosted), Claude Code v2.1.80+

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `whatsapp.ts` | Create | Complete channel server: MCP init, webhook HTTP listener, allowlist gate, reply tool |
| `package.json` | Create | Bun project manifest, pins `@modelcontextprotocol/sdk` |
| `.env.example` | Create | Template for all required env vars with placeholders |
| `.mcp.json` | Create | Registers server with Claude Code |
| `.gitignore` | Create | Ignores `.env`, `node_modules` |

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `.env.example`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "claude-whatsapp",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "bun run whatsapp.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  }
}
```

- [ ] **Step 2: Create `.gitignore`**

```
.env
node_modules/
bun.lockb
```

- [ ] **Step 3: Create `.env.example`**

```
EVOLUTION_API_URL=http://localhost:8080
EVOLUTION_API_KEY=your-api-key-here
EVOLUTION_INSTANCE=your-instance-name
ALLOWED_NUMBER=15551234567
EVOLUTION_WEBHOOK_SECRET=your-webhook-secret-here
WEBHOOK_PORT=3456
```

- [ ] **Step 4: Install dependencies**

Run: `bun install`
Expected: `bun.lockb` created, `node_modules/@modelcontextprotocol` present

- [ ] **Step 5: Commit scaffold**

```bash
git add package.json .gitignore .env.example
git commit -m "feat: project scaffold with deps and env template"
```

---

## Task 2: Environment validation

**Files:**
- Create: `whatsapp.ts` (initial skeleton with env validation only)

- [ ] **Step 1: Create `whatsapp.ts` with env validation**

```ts
#!/usr/bin/env bun

// --- Env validation (must run before anything else) ---
const REQUIRED = [
  'EVOLUTION_API_URL',
  'EVOLUTION_API_KEY',
  'EVOLUTION_INSTANCE',
  'ALLOWED_NUMBER',
  'EVOLUTION_WEBHOOK_SECRET',
] as const

for (const key of REQUIRED) {
  if (!process.env[key]) {
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
  webhookPort:    parseInt(process.env.WEBHOOK_PORT ?? '3456', 10),
}

console.error('[whatsapp] Env validated. Starting...')
```

- [ ] **Step 2: Verify validation works — missing var**

Create a `.env` with all vars filled in *except* `EVOLUTION_API_KEY`, then run:
```bash
bun run whatsapp.ts
```
Expected output on stderr: `[whatsapp] Missing required env var: EVOLUTION_API_KEY` and exit code 1.

- [ ] **Step 3: Verify validation works — bad number format**

Set `ALLOWED_NUMBER=+15551234567` (with a `+`) and run:
```bash
bun run whatsapp.ts
```
Expected output: `[whatsapp] ALLOWED_NUMBER must be digits only...` and exit code 1.

- [ ] **Step 4: Verify validation passes with correct .env**

Create `.env` with all valid values and run:
```bash
bun run whatsapp.ts
```
Expected output: `[whatsapp] Env validated. Starting...` (then hangs or errors because MCP server isn't wired yet — that's fine).

- [ ] **Step 5: Commit**

```bash
git add whatsapp.ts
git commit -m "feat: startup env validation with fail-fast"
```

---

## Task 3: MCP server initialisation

**Files:**
- Modify: `whatsapp.ts` — add MCP server init + stdio connection

- [ ] **Step 1: Add imports and MCP server to `whatsapp.ts`**

Add at the top of the file (before env validation):

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
```

After the `ENV` block, add the MCP server construction:

```ts
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
```

At the bottom of the file, connect over stdio:

```ts
// --- Connect to Claude Code ---
await mcp.connect(new StdioServerTransport())
console.error('[whatsapp] MCP server connected.')
```

- [ ] **Step 2: Verify server connects**

With a valid `.env`, run:
```bash
bun run whatsapp.ts
```
Expected: `[whatsapp] Env validated. Starting...` then `[whatsapp] MCP server connected.` — process stays alive waiting on stdio. Press Ctrl+C to stop.

- [ ] **Step 3: Commit**

```bash
git add whatsapp.ts
git commit -m "feat: MCP server init with claude/channel capability"
```

---

## Task 4: XML escape utility

**Files:**
- Modify: `whatsapp.ts` — add `xmlEscape` helper

- [ ] **Step 1: Add `xmlEscape` function**

Add this function after the `ENV` block and before the MCP server construction:

```ts
function xmlEscape(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
```

- [ ] **Step 2: Manually verify the function in a Bun REPL**

Run:
```bash
bun repl
```
Then paste:
```ts
function xmlEscape(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;')
}
console.log(xmlEscape('<script>alert("xss")</script>'))
console.log(xmlEscape("what's up & more"))
```
Expected:
```
&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;
what&apos;s up &amp; more
```
Press Ctrl+D to exit.

- [ ] **Step 3: Commit**

```bash
git add whatsapp.ts
git commit -m "feat: xml escape utility for prompt injection prevention"
```

---

## Task 5: Reply tool registration

**Files:**
- Modify: `whatsapp.ts` — register `ListTools` and `CallTool` handlers

- [ ] **Step 1: Add ListTools handler**

Add after the `mcp` construction (before `mcp.connect`):

```ts
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
```

- [ ] **Step 2: Add CallTool handler**

Add directly after the ListTools handler:

```ts
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

  // Warn if instance doesn't match env (not an error — still send)
  if (instance !== ENV.instance) {
    console.error(
      `[whatsapp] Warning: reply instance "${instance}" doesn't match EVOLUTION_INSTANCE "${ENV.instance}"`,
    )
  }

  const url = `${ENV.apiUrl}/message/sendText/${instance}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: ENV.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ number: phone, text }),
  })

  if (!res.ok) {
    const body = await res.text()
    console.error(`[whatsapp] Reply failed: ${res.status} ${body}`)
    return {
      content: [{ type: 'text' as const, text: `Failed to send: ${res.status} ${body}` }],
      isError: true,
    }
  }

  console.error(`[whatsapp] Replied to ${phone} on ${instance}`)
  return { content: [{ type: 'text' as const, text: 'sent' }] }
})
```

- [ ] **Step 3: Verify the server still starts cleanly**

```bash
bun run whatsapp.ts
```
Expected: same startup messages as before, no errors. Ctrl+C to stop.

- [ ] **Step 4: Commit**

```bash
git add whatsapp.ts
git commit -m "feat: reply tool - sends whatsapp message via evolution api"
```

---

## Task 6: Webhook HTTP listener

**Files:**
- Modify: `whatsapp.ts` — add Bun HTTP server at the bottom

- [ ] **Step 1: Add the HTTP webhook server**

Add after `mcp.connect(...)` at the bottom of the file:

```ts
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

    // 1. Verify webhook secret
    const incomingSecret = req.headers.get('apikey')
    if (incomingSecret !== ENV.webhookSecret) {
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

    return new Response('ok')
  },
})

console.error(`[whatsapp] Webhook listener on http://127.0.0.1:${ENV.webhookPort}/webhook`)
```

- [ ] **Step 2: Verify the server starts with webhook listener**

```bash
bun run whatsapp.ts
```
Expected output:
```
[whatsapp] Env validated. Starting...
[whatsapp] MCP server connected.
[whatsapp] Webhook listener on http://127.0.0.1:3456/webhook
```

- [ ] **Step 3: Test webhook secret rejection**

In a second terminal, send a request with the wrong secret:
```bash
curl -s -X POST http://localhost:3456/webhook \
  -H "apikey: wrong-secret" \
  -H "Content-Type: application/json" \
  -d '{"event":"messages.upsert","data":{"key":{"remoteJid":"15551234567@s.whatsapp.net","fromMe":false,"id":"test"},"message":{"conversation":"hello"}}}'
```
Expected: curl returns `ok`, server logs `Webhook secret mismatch — dropping request`

- [ ] **Step 3b: Test outbound echo drop (`fromMe: true`)**

Send with correct secret and your allowlisted number but `fromMe: true`:
```bash
curl -s -X POST http://localhost:3456/webhook \
  -H "apikey: your-webhook-secret" \
  -H "Content-Type: application/json" \
  -d '{"event":"messages.upsert","instance":"my-instance","data":{"key":{"remoteJid":"YOUR_NUMBER@s.whatsapp.net","fromMe":true,"id":"echo1"},"message":{"conversation":"echo"}}}'
```
Expected: curl returns `ok`, no `Message from` log line (silently dropped — prevents reply loops)

- [ ] **Step 4: Test allowlist rejection**

Send with the correct secret but a different phone number (replace `your-webhook-secret` with your actual value):
```bash
curl -s -X POST http://localhost:3456/webhook \
  -H "apikey: your-webhook-secret" \
  -H "Content-Type: application/json" \
  -d '{"event":"messages.upsert","instance":"my-instance","data":{"key":{"remoteJid":"19999999999@s.whatsapp.net","fromMe":false,"id":"test"},"message":{"conversation":"hello"}}}'
```
Expected: curl returns `ok`, server logs `Dropping message from non-allowlisted sender: 19999999999`

- [ ] **Step 5: Test successful notification emit**

Send with the correct secret AND your allowlisted number:
```bash
curl -s -X POST http://localhost:3456/webhook \
  -H "apikey: your-webhook-secret" \
  -H "Content-Type: application/json" \
  -d '{"event":"messages.upsert","instance":"my-instance","data":{"key":{"remoteJid":"YOUR_NUMBER@s.whatsapp.net","fromMe":false,"id":"abc123"},"message":{"conversation":"hello claude"}}}'
```
Expected: curl returns `ok`, server logs `Message from YOUR_NUMBER: hello claude`

- [ ] **Step 6: Commit**

```bash
git add whatsapp.ts
git commit -m "feat: webhook http listener with secret verification and allowlist gate"
```

---

## Task 7: MCP registration and config files

**Files:**
- Create: `.mcp.json`

- [ ] **Step 1: Create `.mcp.json`**

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "bun",
      "args": ["./whatsapp.ts"],
      "env": {}
    }
  }
}
```

Note: Claude Code will inherit your shell env (where `.env` values should be loaded). If Claude Code doesn't pick up `.env` automatically, you'll need to source it in your shell before starting Claude Code, or use a wrapper script.

- [ ] **Step 2: Commit**

```bash
git add .mcp.json
git commit -m "feat: .mcp.json registers whatsapp channel with claude code"
```

---

## Task 8: End-to-end smoke test with Claude Code

**Pre-requisites:**
- `.env` filled in with real values
- Evolution API running at `EVOLUTION_API_URL`
- Evolution API webhook configured to POST to `http://localhost:3456/webhook` on `MESSAGES_UPSERT` with the correct secret

- [ ] **Step 1: Load `.env` in your shell**

```bash
set -a && source .env && set +a
```

- [ ] **Step 2: Start Claude Code with the channel**

```bash
claude --dangerously-load-development-channels server:whatsapp
```

Expected: Claude Code starts. In a second terminal you can tail Claude's output or watch for the whatsapp server log lines.

- [ ] **Step 3: Configure Evolution API webhook (if not done yet)**

In your Evolution API dashboard or via its REST API, set:
- Webhook URL: `http://localhost:3456/webhook`
- Events: `MESSAGES_UPSERT`
- Token/Secret: value of `EVOLUTION_WEBHOOK_SECRET` from your `.env`

- [ ] **Step 4: Send a WhatsApp message from your allowlisted number**

Send any message (e.g. "hello") from your phone to the WhatsApp number connected to your Evolution API instance.

Expected: Claude Code receives a `<channel>` event and responds. The response is sent back to your WhatsApp via the `reply` tool.

- [ ] **Step 5: Verify reply is received on WhatsApp**

Check your phone — Claude's reply should arrive within a few seconds.

- [ ] **Step 6: Final commit**

```bash
git add .
git commit -m "feat: complete whatsapp claude code channel - end to end"
```

---

## Quick Reference: Evolution API Payload Shape

The webhook body from Evolution API for a text message looks like:

```json
{
  "event": "messages.upsert",
  "instance": "my-instance",
  "data": {
    "key": {
      "remoteJid": "15551234567@s.whatsapp.net",
      "fromMe": false,
      "id": "ABCDEF123456"
    },
    "message": {
      "conversation": "Hello Claude!"
    }
  }
}
```

For reply messages (quoted text), the text is at `data.message.extendedTextMessage.text`. Both paths are handled in Task 6.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Missing required env var` on startup | `.env` not loaded into shell | Run `export $(grep -v '^#' .env \| xargs)` first |
| Webhook requests not arriving | Evolution API webhook URL wrong | Set to `http://localhost:3456/webhook` |
| Secret mismatch errors | `EVOLUTION_WEBHOOK_SECRET` doesn't match Evolution API config | Ensure both sides use the same value |
| `reply` tool returns 404/401 | Wrong `EVOLUTION_API_URL` or `EVOLUTION_API_KEY` | Verify with `curl $EVOLUTION_API_URL/instance/fetchInstances -H "apikey: $EVOLUTION_API_KEY"` |
| Claude Code doesn't see the channel | `--dangerously-load-development-channels server:whatsapp` flag missing | Add the flag when starting `claude` |
| Messages from self echoed back | `fromMe` check missing | Handled in Task 6 — ensure you're running the latest `whatsapp.ts` |
