# ritvox-backend

Standalone API server for **RitVox School OS** — a multi-tenant school ERP for tier-2/tier-3 city schools in India.

Stack: **Node.js + Express (TypeScript) + Prisma + Neon Postgres** (per TRD Section 1). No Docker anywhere.

## Project structure

```
prisma/              # Prisma schema + migrations
src/
  index.ts           # Entry point (server bootstrap, graceful shutdown)
  app.ts             # Express app factory (middleware + route mounting)
  routes/            # Route definitions, mounted under /api/v1
  controllers/       # Request/response handling
  services/          # Business logic (empty at scaffold phase)
  middleware/        # cors.ts, error.ts
  lib/prisma.ts      # Singleton Prisma client
```

## API

| Method | Path                | Description                          |
|--------|---------------------|--------------------------------------|
| GET    | `/api/v1/health`    | Service + database status JSON       |

All endpoints are versioned under `/api/v1/` per TRD Section 5.

## Local development

```bash
npm install

# 1. Copy .env.example to .env and set DATABASE_URL to your Neon connection string
# 2. Run migrations
npx prisma migrate dev

# 3. Start dev server (localhost:4000)
npm run dev
```

Verify: `curl http://localhost:4000/api/v1/health`

## Environment variables

| Variable       | Required | Description                                                        |
|----------------|----------|--------------------------------------------------------------------|
| `DATABASE_URL` | Yes      | Neon Postgres connection string (`sslmode=require`)                |
| `PORT`         | No       | Defaults to 4000 locally; set by most hosting platforms            |
| `CORS_ORIGINS` | No       | Comma-separated allowed origins. Defaults to `http://localhost:3000` |

### CORS / production frontend domains

Dev allows `http://localhost:3000` (the frontend's local URL). When the frontend is deployed,
add its production/preview domains via the `CORS_ORIGINS` env var in your hosting dashboard:

```
CORS_ORIGINS=https://ritvox-frontend.vercel.app,https://ritvox-git-main.vercel.app
```

Never use `*` in production (TRD Section 8).

## Deployment (any Node platform)

No Dockerfile needed — this deploys as a plain Node service (Render native Node buildpack,
Railway, Fly.io, etc.):

- **Build command:** `npm install && npm run prisma:generate && npm run build`
  (on Render: Build = `npm install && npx prisma generate && npm run build`)
- **Start command:** `npm start`
- **Health check path:** `/api/v1/health`
- Set `DATABASE_URL`, `CORS_ORIGINS`, and any future secrets in the platform's environment settings — never committed to this repo.
- Use your platform's Node.js 20+ runtime (e.g., set `NODE_VERSION=22` on Render).
