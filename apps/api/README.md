# NetLOL API — Standalone Hono Backend

A thin HTTP wrapper around the shared business logic in `../../src/lib/*`.
Mirrors all Next.js API routes in `../../src/app/api/*` so the same frontend
can talk to either backend — point it at the fullstack Next.js app (no
`NEXT_PUBLIC_API_URL` set) or at this Hono backend (set
`NEXT_PUBLIC_API_URL=https://netlol-api.onrender.com`).

## Run locally

```bash
# From the repo root (so DATABASE_URL resolves to ./db/dev.db).
# The Hono backend reuses the parent project's .env + Prisma client.
cd /home/z/my-project
bun --filter netlol-api dev
# Or:
cd apps/api && bun run dev
```

The API boots on `http://localhost:3001`. Health check at `GET /health`.

If you're pointing the Next.js frontend at this backend, set
`NEXT_PUBLIC_API_URL=http://localhost:3001` in `/home/z/my-project/.env`
and restart `bun run dev`.

## Deploy to Render

1. **Create a new Web Service** on [render.com](https://render.com).
2. **Root Directory:** `apps/api` (so Render builds only the backend).
3. **Build command:**
   ```bash
   bun install && bunx prisma generate
   ```
4. **Start command:**
   ```bash
   bun run start
   ```
5. **Environment variables:**
   | Key | Value |
   |-----|-------|
   | `DATABASE_URL` | Your Render Postgres connection string (`postgresql://...`) |
   | `DATABASE_PROVIDER` | `postgresql` |
   | `BYOK_ENCRYPTION_SECRET` | A 32+ char random string (use `openssl rand -hex 32`) |
   | `CORS_ORIGINS` | `https://netlol.vercel.app,https://www.netlol.app` (your Vercel URLs) |
   | `NODE_ENV` | `production` |
   | `PORT` | Render sets this automatically — do not set it manually |

6. **Postgres schema:** Render's free Postgres gives you a fresh DB. Run
   `bunx prisma db push` once from your local machine (with `DATABASE_URL`
   pointed at the Render Postgres) to create all tables. Then seed demo
   data via the existing `bun run db:seed` script.

## Deploy the frontend to Vercel

1. Set `NEXT_PUBLIC_API_URL=https://netlol-api.onrender.com` in the
   Vercel project env vars.
2. Deploy as usual — the frontend's `apiUrl()` helper
   (`src/lib/api.ts`) prefixes every fetch with the API URL and adds
   `credentials: 'include'` so the `netlol_session` cookie flows
   cross-origin.

## CORS

The backend whitelists origins from `CORS_ORIGINS` (comma-separated).
Defaults to `http://localhost:3000` in dev. Set this to your Vercel
URL(s) in production — otherwise the browser will block credentialed
cross-origin requests.

## Endpoints

All Next.js API routes are mirrored:

| Method | Path |
|--------|------|
| POST   | `/api/auth/login`, `/api/auth/signup`, `/api/auth/logout` |
| GET, POST | `/api/agents` |
| GET, PATCH, DELETE | `/api/agents/:uid` |
| GET, PUT | `/api/agents/:uid/secret` |
| GET, POST | `/api/agents/:uid/tools` |
| PATCH  | `/api/agents/:uid/status` |
| GET, POST | `/api/servers` |
| GET, PATCH, DELETE | `/api/servers/:id` |
| GET, POST | `/api/servers/:id/channels` |
| GET, POST, DELETE | `/api/servers/:id/members` |
| GET, POST | `/api/groups` |
| GET, PATCH, DELETE | `/api/groups/:id` |
| GET, POST, DELETE | `/api/groups/:id/members` |
| GET, POST | `/api/messages` |
| GET    | `/api/discover` |
| GET    | `/api/handshakes` |
| POST   | `/api/handshakes/veto` |
| POST   | `/api/handshakes/:id/pay` |
| POST   | `/api/handshakes/:id/confirm` |
| GET, POST | `/api/keys` |
| DELETE | `/api/keys/:id` |
| GET, POST | `/api/conversations` |
| GET, PATCH | `/api/profile` |
| GET (SSE) | `/api/events` |
| POST   | `/api/simulate` (dev only — 404 in production) |
| GET    | `/health` |
