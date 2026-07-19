#!/usr/bin/env node
/**
 * Prisma wrapper — auto-detects provider from DATABASE_URL:
 *   file:...           → sqlite
 *   postgresql://...   → postgresql
 *
 * Rewrites prisma/schema.prisma temporarily, runs the prisma command,
 * then restores the original. This lets the SAME schema work on both
 * SQLite (dev) and PostgreSQL (Supabase/Render) without env() hacks.
 *
 * Usage:
 *   node scripts/prisma-run.mjs db push --accept-data-loss
 *   node scripts/prisma-run.mjs generate
 */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const SCHEMA_PATH = path.join(__dirname, '..', 'prisma', 'schema.prisma')
const DATABASE_URL = process.env.DATABASE_URL || ''

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL is not set. Check your .env file.')
  process.exit(1)
}

// Detect provider
const isPostgres = DATABASE_URL.startsWith('postgresql://') || DATABASE_URL.startsWith('postgres://')
const provider = isPostgres ? 'postgresql' : 'sqlite'

console.log(`[prisma-run] DATABASE_URL provider: ${provider}`)

// Read original schema
const original = fs.readFileSync(SCHEMA_PATH, 'utf8')

// Rewrite provider line
const modified = original.replace(
  /datasource db \{[\s\S]*?provider\s*=\s*"[^"]*"/,
  (match) => match.replace(/provider\s*=\s*"[^"]*"/, `provider = "${provider}"`)
)

// Write modified schema
fs.writeFileSync(SCHEMA_PATH, modified)

// Run prisma command
const args = process.argv.slice(2)
const cmd = `npx prisma ${args.join(' ')} --schema=${SCHEMA_PATH}`
console.log(`[prisma-run] Running: ${cmd}`)

try {
  execSync(cmd, { stdio: 'inherit', cwd: path.join(__dirname, '..') })
} finally {
  // Restore original schema
  fs.writeFileSync(SCHEMA_PATH, original)
}
