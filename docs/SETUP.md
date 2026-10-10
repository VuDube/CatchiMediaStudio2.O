# Setup and deployment

## Prerequisites

- The existing Cloudflare account and Worker `catchimediastudio2-o`.
- KV namespace `METADATA` (ID `90754c58723443dc8bc5248a0f5873fa`).
- Workers AI binding `AI` enabled for the account and access to the documented model IDs in `docs/RESEARCH.md`.
- Queues named `catchimedia-studio-jobs` and `catchimedia-studio-dlq`.
- Node.js 22 for local checks; Wrangler 4 is locked by `package-lock.json`.

The application intentionally has no Groq/Hugging Face fallback. Keep generation within the finite free allocations documented by Cloudflare; the app's budget estimate cannot observe other Workers AI consumers in the account.

## Runtime bindings and secrets

The Worker expects these bindings:

| Name | Type | Notes |
|---|---|---|
| `AI` | Workers AI | Cloudflare Workers AI only |
| `METADATA` | KV namespace | Existing namespace ID above |
| `GENERATION_QUEUE` | Queue producer | Main queue; messages contain opaque job IDs only |
| `ADMIN_PASSWORD_HASH` | Secret text | Lowercase hexadecimal SHA-256 digest of the administrator password; never the plaintext password |
| `SESSION_SECRET` | Secret text | Random high-entropy value used for signed, expiring admin sessions |
| `APP_VERSION` | Plain text | Release version |
| `GITHUB_OWNER`, `GITHUB_REPO` | Plain text | Used only to retrieve legacy public-release assets |

The Worker API also needs the main queue's consumer configuration: one message per batch, a bounded retry count, a delay, and `catchimedia-studio-dlq` as the dead-letter queue. Attach a bounded dead-letter consumer so exhausted jobs are marked failed. `wrangler.toml` records the intended declarations.

Configure secrets in the Cloudflare Worker dashboard or through an authorized deployment channel. Do not store passwords, API tokens, `.dev.vars`, or generated private media in this repository. Use a unique password (at least 16 characters) and a separate random session secret. If an administrator password is rotated, update only the hash secret; existing signed sessions remain subject to their expiration.

## GitHub Actions deployment

The `Deploy CatchiMediaStudio to Cloudflare` workflow runs only when manually invoked on `main` and the `confirm` input is set to `deploy`. CI runs on pushes and pull requests but has no production credentials and cannot publish.

For future Actions deployments, add the following repository Actions secrets through the repository's Settings UI:

| Secret | Use |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Scoped token with only the account/Worker deployment permissions required by Wrangler, plus Queue and binding management only if the workflow is allowed to provision them |
| `CLOUDFLARE_ACCOUNT_ID` | The exact Cloudflare account ID |

The production workflow is intentionally manual and targets the `production` GitHub environment. Configure required reviewers/branch protection there if the account policy requires a second-person approval. The public URL is `https://catchimediastudio2-o.vusumuzi-dube.workers.dev` for the current account workers.dev subdomain.

After deployment, the workflow checks the public PWA shell, manifest, API health and unauthenticated `/api/projects` boundary (expected `401`). It intentionally does not run live AI inference during deployment: that could spend finite account-wide Workers AI allowance. Test media generation deliberately from the signed-in app only after reviewing account usage.

## Local validation

```sh
npm ci
npm test
npm audit --audit-level=high
npx wrangler deploy --dry-run --outdir .wrangler/dry-run
```

The dry-run does not deploy. A local mock/provider test validates request and result handling without calling Workers AI. For actual account deployment, use the protected workflow rather than committing credentials.

## Storage and migration notes

- New generated image/speech bytes and assembled videos are browser-local. Download important files and keep a separate backup; the service worker does not sync media.
- Text results, transcripts, projects, and job metadata use KV with application retention. Queue retention on the Free plan is 24 hours and is not a history store.
- Existing GitHub Release assets from the previous implementation were not migrated or deleted. The repository is public; old release URLs may be public. The read-only legacy audit workflow never deletes files.
- Existing legacy API tokens, if still bound to the Worker, are not used for new generation or provider fallback. Do not rotate or delete unrelated account secrets without reviewing other consumers.

## Current product limits

- Image prompts: up to 2,048 characters; model steps 1–8; generated media up to 8 MiB.
- TTS input: up to 1,200 characters; English/French integration only; output up to 4 MiB.
- ASR input: up to 512 KiB; audio MIME types are validated.
- Text input: up to 2,000 characters; queued result up to 12,000 characters.
- Browser video assembly: up to 10 images, 60 seconds per assembly, WebM codec and browser support required; no server-side video encoder or prompt-to-video provider is configured.
