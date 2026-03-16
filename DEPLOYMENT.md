# Deployment Guide

## Vercel (recommended for quick deploy)

The app **builds and runs on Vercel**, but with one important limitation:

- **EVA voice (Nova Sonic)** uses a **WebSocket** at `/api/nova-sonic/ws`, which is served by the **custom Node server** (`server.mjs`). Vercel’s serverless runtime does **not** run this server, so **live voice with EVA will not work** on a standard Vercel deploy. The rest of the app (albums, photos, Living Storybook, Scrapbook, Editor, Nano Banana crop, etc.) works.

### Deploy to Vercel

1. **Connect the repo** to Vercel (GitHub/GitLab/Bitbucket).

2. **Set environment variables** in the Vercel project (Settings → Environment Variables). Use the same keys as in `.env.example`:
   - **Required:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
   - **For EVA voice elsewhere:** `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`
   - **Optional:** `ELEVENLABS_API_KEY`, `GEMINI_API_KEY`, `NOVA_SONIC_MODEL_ID`, `NOVA_MODEL_ID`, `NEXT_PUBLIC_BASE_URL`, etc.

3. **Build & deploy**
   - Build command: `npm run build` (default)
   - Output: Next.js (default)
   - No custom start command; Vercel uses its own serverless runtime.

4. **Optional:** Set `NEXT_PUBLIC_BASE_URL` to your Vercel URL (e.g. `https://your-app.vercel.app`) for server-side callbacks that need the app URL.

---

## Full functionality (including EVA voice)

To run **EVA voice (Nova Sonic WebSocket)** you need a host that runs the **custom server**, not only `next start`.

### Option A: Railway / Render / Fly.io (recommended for demo)

1. Use **Node** (not a static/Next-only) environment.
2. **Start command:** `node server.mjs`
3. **Build:** `npm run build` then start with `node server.mjs` (server serves the built Next app and the WebSocket).
4. Set the same env vars as in `.env.example`.

### Option B: Vercel + separate WebSocket server

- Deploy the Next app to Vercel as above.
- Run **only** the WebSocket proxy (e.g. a small Node service that mirrors the Nova Sonic logic from `server.mjs`) on Railway/Render/Fly.io.
- Point the frontend to that WebSocket URL (would require a small code change and an env var like `NEXT_PUBLIC_WS_URL`).

---

## Environment variables summary

| Variable | Required | Used for |
|--------|----------|----------|
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role (API routes) |
| `AWS_ACCESS_KEY_ID` | For Nova/Polly | Nova Sonic, Nova Lite, Polly TTS |
| `AWS_SECRET_ACCESS_KEY` | For Nova/Polly | Same |
| `AWS_REGION` | For Nova/Polly | e.g. `us-east-1` |
| `ELEVENLABS_API_KEY` | For voice clone | Voice cloning, cloned-voice TTS |
| `GEMINI_API_KEY` | Optional | Style transfer (Disney/Ghibli/etc.), fallback quality |
| `NEXT_PUBLIC_BASE_URL` | Optional | Full URL of the app (e.g. for server-side redirects) |

Copy `.env.example` to `.env.local` and fill values. **Do not commit `.env.local`.**

---

## Build and run locally

```bash
npm install
npm run build
npm run start   # runs node server.mjs (Next + WebSocket)
# Or for dev:
npm run dev     # same, with hot reload
```

---

## What might break on Vercel

- **EVA voice (Nova Sonic):** WebSocket at `/api/nova-sonic/ws` is not available; “Connect” or “Talk to EVA” will fail or hang. All other features (albums, photos, storybook, scrapbook, editor, Nano Banana crop, narration, etc.) use HTTP API routes and work on Vercel.
- **Long-running API routes:** `vercel.json` sets `maxDuration` for heavy routes (e.g. animate, narration, nano-banana, analyze-photo). If you hit timeouts, increase those values in the Vercel plan limits.
