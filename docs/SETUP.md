# CatchiMediaStudio2.O — Browser-Only Setup Guide

Every step below is performed in a web browser. No terminal, no CLI, no local install — for development, deployment, or administration.

## 0. One-time workflow move

The automation token cannot write into `.github/workflows/` (GitHub requires the special `workflow` scope). Move the two workflow files via the web UI:

1. Repo → **Add file → Create new file** → name it `.github/workflows/deploy.yml` → paste the contents of `ci/deploy.yml` → **Commit changes**.
2. Repeat for `.github/workflows/maintenance.yml` ← `ci/maintenance.yml`.
3. Delete the `ci/` folder (open any file in it → **⋯ → Delete file**).

## 1. Cloudflare resources (dashboard.cloudflare.com)

Already provisioned for this project:

- Worker script: `catchimediastudio2-o`
- KV namespace: `catchimediastudio2o-metadata` (ID in `wrangler.toml`)

Remaining items:

1. **Manage Account → Account API Tokens → Create Token** → use the **Edit Cloudflare Workers** template → copy the token.
2. Copy your **Account ID** from the dashboard URL or the Workers overview sidebar.

## 2. GitHub secrets (repo → Settings → Secrets and variables → Actions)

| Secret | Required | Purpose |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | ✅ | Lets the Action deploy the Worker |
| `CLOUDFLARE_ACCOUNT_ID` | ✅ | Targets the correct account |
| `ASSET_GITHUB_TOKEN` | optional | Fine-grained PAT (Contents: read+write on this repo). Enables media storage on GitHub Releases; without it, binaries fall back to KV-inline storage |
| `GROQ_API_KEY` | optional | High-throughput text tier (free at console.groq.com) |
| `HF_TOKEN` | optional | Hugging Face Inference Providers routing |

The deploy workflow maps `ASSET_GITHUB_TOKEN` → Worker secret `GITHUB_TOKEN`, and passes `GROQ_API_KEY` / `HF_TOKEN` through to the Worker via `wrangler-action`.

## 3. Deploy

- **Automatic:** every push to `main` builds (`scripts/build.mjs`) and deploys.
- **Manual:** repo → **Actions → Deploy to Cloudflare Workers → Run workflow** → confirm. This is the zero-CLI on-demand deploy button.
- Your studio lives at `https://catchimediastudio2-o.<your-subdomain>.workers.dev`.

## 4. Develop in the browser

Repo → green **Code → Codespaces → Create codespace on main**. The `.devcontainer` preinstalls Node 22 and dependencies. Edit, run `npm run dev` in the Codespaces editor, commit, push — the Action deploys.

## 5. Operate

- **Operations tab** in the studio shows today's counters against free-tier budgets (10,000 neurons/day, 100k KV reads/day, 1k KV writes/day).
- **maintenance.yml** runs daily with the built-in `GITHUB_TOKEN` and deletes release assets older than 60 days — keeps you inside GitHub free storage quotas. The in-worker cron cleanup does the same as a belt-and-braces measure (requires `GITHUB_TOKEN` secret on the Worker).
- The background queue (`POST /api/queue`) is drained every minute by the Worker's Cron Trigger.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Deploy Action fails with auth error | Token lacks Workers Edit scope | Recreate token with the **Edit Cloudflare Workers** template |
| `githubStorage: false` in Operations | `ASSET_GITHUB_TOKEN` not set | Add the secret and re-run the deploy Action |
| Image/text works, gallery empty | Nothing generated yet, or KV listing lag | Generate an asset; KV list consistency is eventually consistent (~60s) |
| 429 on generation | 30 requests/hour/IP limit | Wait for the window reset (see `retryAfterSeconds`) |
