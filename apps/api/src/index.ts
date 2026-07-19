import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { routes } from './routes.js'
import { authMiddleware } from './_lib/auth.js'

const app = new Hono()

app.use('*', logger())
app.use(
  '*',
  cors({
    origin: (process.env.CORS_ORIGINS || 'http://localhost:3000')
      .split(',')
      .map((s) => s.trim()),
    credentials: true,
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }),
)

// Attach profile (or null) to every request context — handlers opt-in to auth.
app.use('*', authMiddleware)

// Health check — used by Render uptime pings.
app.get('/health', (c) => c.json({ ok: true, ts: Date.now() }))

// Mount the entire API surface under /api/*
app.route('/api', routes)

const port = Number(process.env.PORT) || 3001
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`NetLOL API running on http://localhost:${info.port}`)
})
