#!/usr/bin/env node
/**
 * NetLOL — Create hidden admin account.
 *
 * Usage:
 *   bun scripts/create-admin.ts
 *   # or: npx tsx scripts/create-admin.ts
 *
 * The admin account:
 *   - Has role='admin' (not visible in agent lists, discovery, or UI)
 *   - Can log in via the normal login page
 *   - Gets pro plan with no expiration
 *   - Is NOT created by the seed script — run this manually once
 *
 * The script is interactive — it prompts for email + password.
 */

const readline = require('readline')

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(question, (answer: string) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

async function main() {
  const { PrismaClient } = require('@prisma/client')
  const bcrypt = require('bcryptjs')
  const db = new PrismaClient()

  console.log('\n🔐 NetLOL — Admin account creation\n')
  console.log('This account is HIDDEN from the UI (not in agent lists, discovery, etc.)\n')

  const email = await ask('Admin email: ')
  if (!email || !email.includes('@')) {
    console.error('❌ Invalid email')
    process.exit(1)
  }

  const username = await ask('Admin username: ')
  if (!username || username.length < 3) {
    console.error('❌ Username must be 3+ chars')
    process.exit(1)
  }

  const password = await ask('Admin password (8+ chars): ')
  if (!password || password.length < 8) {
    console.error('❌ Password must be 8+ chars')
    process.exit(1)
  }

  // Check if already exists
  const existing = await db.profile.findFirst({
    where: { OR: [{ email }, { username }] },
  })
  if (existing) {
    console.error(`❌ Account already exists: ${existing.email}`)
    if (existing.role === 'admin') {
      console.log('   (It is already an admin)')
    }
    process.exit(1)
  }

  const passwordHash = await bcrypt.hash(password, 12)
  const admin = await db.profile.create({
    data: {
      email,
      username,
      passwordHash,
      role: 'admin',
      plan: 'pro',
      planExpiresAt: null,
      vetoTimeoutSeconds: 120,
    },
  })

  console.log('\n✅ Admin account created:')
  console.log(`   ID:       ${admin.id}`)
  console.log(`   Email:    ${admin.email}`)
  console.log(`   Username: ${admin.username}`)
  console.log(`   Role:     ${admin.role}`)
  console.log(`   Plan:     ${admin.plan}`)
  console.log('\n   Login via the normal login page. The account is hidden from UI.\n')

  await db.$disconnect()
}

main().catch(e => {
  console.error('❌ Failed:', e.message)
  process.exit(1)
})
