# Security and privacy notes

## Access boundary

- There is one administrator and no public registration or multi-user tenancy.
- Authenticated endpoints require a signed, expiring session cookie. Mutations validate same-origin `Origin`; credentials use same-origin cookies, and API requests are never cached by the PWA service worker.
- Request parsing, prompts, model output, audio uploads, project fields and asset metadata are size-bounded and validated. Provider errors never become fabricated success output.
- Frontend user content is inserted through text nodes and form values rather than dynamic HTML parsing. The build rejects inline script/style, `innerHTML` assignment and `eval()` patterns. Static responses set CSP, frame denial, MIME sniffing, referrer and permissions policies.
- Login relies on a Cloudflare Worker secret hash and a separate HMAC/session secret. Never commit those values or expose them in logs.

## Data handling

| Data | Location | Product behavior |
|---|---|---|
| Project metadata, small text outputs and transcripts | Cloudflare KV | Private API; application TTLs and owner check |
| Queue payload | Cloudflare Queue | Opaque job ID only; finite 24-hour Free retention |
| New image/speech bytes | Browser IndexedDB, if available; otherwise user download | Not uploaded to an application media bucket |
| Browser-assembled WebM | Browser memory/IndexedDB, if available; download | No server-side recording or upload |
| App source code | Public GitHub repository | Application code is public; no private user media is part of the source |
| Legacy media files | Existing public GitHub Release (historical) | Not migrated or deleted; URLs may be public |

The app gives a visible warning about local-only media and the historical public-release path. Removing a metadata record does not imply deletion of an older GitHub Release file. The maintenance workflow is read-only and does not clean up legacy assets.

## Free-use and provider safety

- Cloudflare Workers AI is the only enabled generation provider. Stored Groq/Hugging Face keys are not referenced by current generation code and are never fallback providers.
- Per-app counters are conservative estimates in KV, not account-wide telemetry and not atomic distributed quotas. Other Workers or services in the account can consume the shared provider allocation.
- Exhausted free allocations, rate limits, invalid provider output and failed queue jobs are represented as errors. There is no promise of unlimited free use.
- Live production deployment smoke checks do not generate image, audio, or text content.

## Known limitations and follow-up review

- A single shared administrator identity is not a multi-tenant access-control system.
- KV is not a transactional database. Budget estimates can race and may lag; use a hard provider-side free allocation as the ultimate financial guardrail.
- Browser-local media can be evicted or lost when browser storage is cleared, quotas are reached, or a device is lost. Download important files.
- The password hash uses SHA-256 as configured secret material; choose a long, unique password. Before adding public account creation or multiple administrators, replace this with a properly salted password-verification and account-lifecycle design.
- Never re-enable public release uploads, scheduled release deletion, paid fallback providers, or new billing resources without explicit privacy, cost and retention review.
