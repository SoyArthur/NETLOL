// Re-export the shared serializers so the Hono route modules can import from
// a single local path. The serializers are pure data transformers and work
// identically under both Next.js and Hono.
export * from '@/app/api/_lib/serialize'
