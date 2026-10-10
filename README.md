# CatchiMediaStudio2.O

**A zero-cost, fully functional AI media/content generation factory — running 100% on the Cloudflare Workers free tier and GitHub free tier. No VPS. No local machine. No terminal required for any part of the lifecycle. No R2. No D1. No mock data, no stubs.**

Live architecture:

```
Browser UI (served by the Worker itself)
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│  Cloudflare Worker: catchimediastudio2-o                │
│  ─ Orchestration router (image / text / speech / queue) │
│  ─ Prompt-hash KV cache (zero quota on repeat prompts)  │
│  ─ Per-IP rate limiting (KV sliding window)             │
│  ─ Daily quota ledger + Operations dashboard            │
│  ─ Cron Trigger: queue processor + lifecycle cleanup    │
└───────┬──────────────────────┬──────────────────────────┘
        │                      │
        ▼                      ▼
 Workers AI (edge)      Workers KV (metadata)
 flux-1-schnell         asset registry, cache,
 llama-3.1-8b           rate limits, job queue,
 melotts TTS            quota ledger
        │
        ▼  (optional tiers, activated by secrets)
 Groq (llama-3.1-8b-instant, high-throughput text)
 Hugging Face Inference Providers (specialized models)
        │
        ▼  (media binaries)
 GitHub Releases on this repo (object store)
 tag: catchi-media-assets  →  proxied through /asset/:id
```

## What is implemented

| Capability | Endpoint | Backend |
|---|---|---|
| Image generation | `POST /api/generate/image` | Workers AI `@cf/black-forest-labs/flux-1-schnell` |
| Text generation | `POST /api/generate/text` | Groq `llama-3.1-8b-instant` (if `GROQ_API_KEY` set) → Workers AI `@cf/meta/llama-3.1-8b-instruct` |
| Speech (TTS) | `POST /api/generate/speech` | Workers AI `@cf/myshell-ai/melotts` |
| Asset gallery | `GET /api/assets?type=` | Workers KV (prefix-scanned) |
| Asset download | `GET /asset/:id` | GitHub Release proxy with `redirect:'manual'` workaround |
| Background queue | `POST /api/queue` | KV queue, drained by Cron Trigger every minute |
| Health / budgets | `GET /api/health` | Live integration + ledger status |
| Lifecycle cleanup | cron (00:xx UTC) + `maintenance.yml` | Deletes release assets older than 60 days |

## Key engineering details

- **GitHub Releases as object storage.** Generated binaries are uploaded as assets to the `catchi-media-assets` release in this repo; only metadata (prompt, model, size, timestamps, asset id) goes to KV.
- **The Workers `fetch` redirect bug workaround.** GitHub asset downloads redirect from `api.github.com` to a signed S3 URL, and Workers drops the `Authorization` header on cross-origin redirects. The proxy therefore fetches with `redirect: 'manual'` and re-requests the `Location` target without the auth header.
- **Prompt-hash caching.** Identical prompts resolve from KV cache — zero neurons, zero API quota spent.
- **Free-tier budgets respected.** 10,000 Workers AI neurons/day, 100k KV reads/day, 1k KV writes/day — tracked in a daily ledger surfaced on the Operations tab.

## Repository layout

```
src/index.js          Orchestration worker (single-module, deployable)
public/index.html     Studio UI (inlined into the worker at build time)
scripts/build.mjs     Build step: inlines the UI → dist/worker.js
wrangler.toml         Bindings (AI, KV), cron trigger, vars
ci/deploy.yml         CI/CD — push-to-deploy + workflow_dispatch (move into .github/workflows/)
ci/maintenance.yml    Daily asset lifecycle cleanup (move into .github/workflows/)
.devcontainer/        GitHub Codespaces environment (browser-based dev)
docs/SETUP.md         Browser-only setup & secrets guide
```

## Deploy it yourself — browser only

1. **Cloudflare dashboard** → the Worker and KV namespace are already provisioned for this project (see `wrangler.toml`).
2. **GitHub repo Settings → Secrets → Actions**: add `CLOUDFLARE_API_TOKEN` (template: *Edit Cloudflare Workers*) and `CLOUDFLARE_ACCOUNT_ID`.
3. Move `ci/deploy.yml` and `ci/maintenance.yml` into `.github/workflows/` via **Add file → Create new file** (one-time step — the automation token cannot write workflow files directly).
4. Push to `main`, or go to **Actions → Deploy to Cloudflare Workers → Run workflow**. Done — no terminal involved.
5. Optional power-ups (same Secrets page): `ASSET_GITHUB_TOKEN` (fine-grained PAT, contents:write on this repo — enables GitHub media storage), `GROQ_API_KEY`, `HF_TOKEN`.

Full details: [docs/SETUP.md](docs/SETUP.md)
