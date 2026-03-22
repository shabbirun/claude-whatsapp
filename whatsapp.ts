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
