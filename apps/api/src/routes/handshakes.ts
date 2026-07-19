import { Hono } from 'hono'
import { db } from '@/lib/db'
import { eventBus } from '@/lib/event-bus'
import { buildTransferTransaction, verifyTransaction } from '@/lib/solana'
import {
  serializeHandshake,
  serializeReputation,
} from '../_lib/serialize.js'
import { getProfile, Vars } from '../_lib/auth.js'

export const handshakeRoutes = new Hono<{ Variables: Vars }>()

// GET /api/handshakes — where requester OR receiver owned by user
handshakeRoutes.get('/', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const handshakes = await db.handshake.findMany({
      where: {
        OR: [
          { requester: { ownerId: profile.id } },
          { receiver: { ownerId: profile.id } },
        ],
      },
      include: { requester: true, receiver: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
    return c.json({ handshakes: handshakes.map(serializeHandshake) })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})

// POST /api/handshakes/veto — veto a payment window
handshakeRoutes.post('/veto', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const { handshakeId } = await c.req.json<{ handshakeId?: string }>()
    if (!handshakeId) {
      return c.json({ error: 'handshakeId is required' }, 400)
    }
    const handshake = await db.handshake.findUnique({
      where: { id: handshakeId },
      include: { requester: true, receiver: true },
    })
    if (!handshake) return c.json({ error: 'not found' }, 404)
    const owns =
      handshake.requester.ownerId === profile.id ||
      handshake.receiver.ownerId === profile.id
    if (!owns) return c.json({ error: 'forbidden' }, 403)
    const updated = await db.handshake.update({
      where: { id: handshakeId },
      data: {
        vetoedByHuman: true,
        status: 'vetoed',
        resolvedAt: new Date(),
      },
      include: { requester: true, receiver: true },
    })
    const serialized = serializeHandshake(updated)
    eventBus.publish({ type: 'handshake-update', handshake: serialized })
    return c.json({ handshake: serialized })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})

// POST /api/handshakes/:id/pay — build unsigned Solana transfer tx
handshakeRoutes.post('/:id/pay', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const id = c.req.param('id')
    const body = (await c.req.json().catch(() => null)) as
      | { fromWallet?: string }
      | null
    const fromWallet = body?.fromWallet?.trim()
    if (!fromWallet) {
      return c.json({ error: 'fromWallet is required' }, 400)
    }
    const handshake = await db.handshake.findUnique({
      where: { id },
      include: { requester: true, receiver: true },
    })
    if (!handshake) return c.json({ error: 'handshake not found' }, 404)
    if (handshake.requester.ownerId !== profile.id) {
      return c.json(
        { error: 'forbidden — only the requester can pay' },
        403,
      )
    }
    if (!handshake.paymentRequired) {
      return c.json({ error: 'handshake does not require payment' }, 400)
    }
    if (handshake.vetoedByHuman) {
      return c.json({ error: 'handshake was vetoed by a human' }, 400)
    }
    if (handshake.paymentConfirmed) {
      return c.json({ error: 'payment already confirmed' }, 400)
    }
    if (!handshake.vetoExpiresAt || handshake.vetoExpiresAt.getTime() > Date.now()) {
      return c.json({ error: 'veto window has not yet expired' }, 400)
    }
    const toWallet = handshake.paymentAddress ?? handshake.receiver.walletAddress
    if (!toWallet) {
      return c.json({ error: 'receiver has no wallet address on file' }, 400)
    }
    const amountUsd = handshake.paymentAmount ?? 0
    if (amountUsd <= 0) {
      return c.json({ error: 'handshake has no payable amount' }, 400)
    }
    const result = await buildTransferTransaction({
      from: fromWallet, to: toWallet, amountUsd,
    })
    if ('error' in result) {
      return c.json({ error: result.error }, 500)
    }
    return c.json(result)
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})

// POST /api/handshakes/:id/confirm — verify on-chain + update handshake
handshakeRoutes.post('/:id/confirm', async (c) => {
  const profile = getProfile(c)
  if (!profile) return c.json({ error: 'unauthorized' }, 401)
  try {
    const id = c.req.param('id')
    const body = (await c.req.json().catch(() => null)) as
      | { txSignature?: string }
      | null
    const txSignature = body?.txSignature?.trim()
    if (!txSignature) {
      return c.json({ error: 'txSignature is required' }, 400)
    }
    const handshake = await db.handshake.findUnique({
      where: { id },
      include: { requester: true, receiver: true },
    })
    if (!handshake) return c.json({ error: 'handshake not found' }, 404)
    const owns =
      handshake.requester.ownerId === profile.id ||
      handshake.receiver.ownerId === profile.id
    if (!owns) return c.json({ error: 'forbidden' }, 403)
    if (!handshake.paymentRequired) {
      return c.json({ error: 'handshake does not require payment' }, 400)
    }
    if (handshake.vetoedByHuman) {
      return c.json({ error: 'handshake was vetoed by a human' }, 400)
    }
    if (handshake.paymentConfirmed) {
      return c.json({
        handshake: serializeHandshake(handshake),
        alreadyConfirmed: true,
      })
    }
    const verify = await verifyTransaction(txSignature)
    if (!verify.confirmed) {
      return c.json(
        { error: verify.error ?? 'transaction not confirmed' },
        400,
      )
    }
    const now = new Date()
    const amountUsd = handshake.paymentAmount ?? 0
    const updated = await db.handshake.update({
      where: { id: handshake.id },
      data: {
        paymentTx: txSignature,
        paymentConfirmed: true,
        status: 'confirmed',
        resolvedAt: now,
      },
      include: { requester: true, receiver: true },
    })
    await db.paymentP2P.create({
      data: {
        handshakeId: handshake.id,
        payerAgentId: handshake.requesterAgentId,
        payeeAgentId: handshake.receiverAgentId,
        amountUsd,
        walletChain: handshake.paymentChain ?? 'solana',
        txSignature,
        status: 'confirmed',
        confirmedAt: now,
      },
    })
    // Update the receiver's reputation (jobsCompleted + totalEarnedUsd).
    const existingRep = await db.reputation.findUnique({
      where: { agentId: handshake.receiverAgentId },
    })
    const prevTotal =
      (existingRep?.jobsCompleted ?? 0) + (existingRep?.jobsFailed ?? 0)
    const prevAvg = existingRep?.avgResponseMs ?? 0
    const responseMs = handshake.createdAt
      ? Math.max(0, now.getTime() - handshake.createdAt.getTime())
      : 3000
    const newAvg =
      prevTotal > 0
        ? Math.round((prevAvg * prevTotal + responseMs) / (prevTotal + 1))
        : responseMs
    const rep = await db.reputation.upsert({
      where: { agentId: handshake.receiverAgentId },
      create: {
        agentId: handshake.receiverAgentId,
        jobsCompleted: 1, jobsFailed: 0, jobsVetoed: 0,
        totalEarnedUsd: amountUsd, totalSpentUsd: 0,
        avgResponseMs: responseMs, successRate: 100,
        verified: true, updatedAt: now,
      },
      update: {
        jobsCompleted: { increment: 1 },
        totalEarnedUsd: { increment: amountUsd },
        avgResponseMs: newAvg,
        successRate: 100,
        verified: true,
        updatedAt: now,
      },
    })
    eventBus.publish({
      type: 'handshake-update',
      handshake: serializeHandshake(updated),
    })
    eventBus.publish({
      type: 'reputation-update',
      agentId: handshake.receiverAgentId,
      reputation: serializeReputation(rep),
    })
    return c.json({ handshake: serializeHandshake(updated) })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'server error' },
      500,
    )
  }
})
