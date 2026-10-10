# Verified platform constraints and model contracts

**Verified:** 2026-10-10 against Cloudflare's current public documentation. These facts are the basis for the initial implementation and should be rechecked before changing model IDs or publishing a new provider.

## Cloudflare Workers Free

The Workers Free plan currently allows 100,000 Worker requests per day, 10 ms of CPU time per request, 128 MB memory, 50 subrequests per request, and a 64 MiB Worker bundle. Requests waiting on network I/O do not consume CPU time, but synchronous CPU-heavy media processing remains inappropriate for the Worker. [1]

Workers AI includes 10,000 Neurons per day at no charge. The documented pricing for paid-plan usage above that allocation is $0.011 per 1,000 Neurons; access above the free allocation requires Workers Paid. Model prices are now presented per model, then converted to Neurons. Therefore, the platform must use only Workers AI through the account's free allocation and must not enable billing-based fallbacks. An exhausted free allocation should become an explicit provider-quota error, never a paid upgrade or false success. [2]

## Workers KV and Queues

Workers KV Free currently allows 100,000 reads and 1,000 writes per day, with writes to the same key limited to once per second. A namespace has a 1 GiB storage limit, keys are limited to 512 bytes and values to 25 MiB. This makes KV suitable for small metadata, not transactional locks or high-frequency mutable counters. [3]

Cloudflare Queues on Workers Free include 10,000 operations per day; each 64 KiB chunk written, read, or deleted counts as an operation. A message commonly costs three operations for write/read/delete. Free-plan message retention is 24 hours and cannot be configured. If adopted, queue usage must be budgeted conservatively and queue retention must never be treated as permanent job history. [4] [5]

## Verified Workers AI model contracts

| Operation | Model ID | Contract and relevant limits |
|---|---|---|
| Text-to-image | `@cf/black-forest-labs/flux-1-schnell` | Request requires `prompt` (maximum 2,048 characters); documented output is a base64 image. The model accepts steps (up to 8) and seed. Its documented sample emits JPEG despite the existing Worker labelling output PNG, so output MIME type must be validated rather than assumed. [6] |
| Text generation | `@cf/meta/llama-3.1-8b-instruct-fp8` | Accepts `messages` and supports `max_tokens`; synchronous response includes `response`. The model exists in the current catalog. [7] |
| Text-to-speech | `@cf/myshell-ai/melotts` | Request requires `prompt` and accepts `lang`. Output is either JSON containing base64 `audio` or binary `audio/mpeg`. The current source handles only the base64 form and must validate whichever form the AI binding returns. [8] |
| Speech-to-text | `@cf/openai/whisper` | Accepts binary audio or an object with `audio` as an array of unsigned-byte values. Output includes `text` and may include word timings and VTT. Uploaded input must be size-bounded before any conversion or inference. [9] |

Cloudflare's current catalog includes the model identifiers above, but catalog presence alone does not prove that a live request succeeds for this particular account. Live inference must be verified separately and only within the no-charge allowance. [10]

## Product and storage implications

- Cloudflare Workers AI is the only default inference provider. Groq, Hugging Face, or any other provider must not be silently used as a fallback because their free quotas, account eligibility, and billing behavior are independent.
- The app must not claim a precise remaining Neuron balance based on local counters. It can report its own completed-job counts, while clearly identifying the official account balance as external telemetry.
- A GitHub Release in a public repository is not private media storage. It must not receive prompts, recordings, or personal assets without an explicit public-distribution choice. The default output path should hand genuine media back to the signed-in owner's browser and allow the owner to download it.
- Cloudflare Workers AI's catalog contains image, text, TTS, and ASR models, but no video-synthesis model is part of the verified default integration. Video planning and actual video synthesis are separate features. Browser-side assembly of generated stills and narration may create a real downloadable video file, but it must be labelled as assembly, not text-to-video inference.
- “Zero cost” is conditional on using eligible free allocations. Requests can fail when daily allocations are exhausted; the application cannot promise unlimited free generation or guaranteed provider availability.

## References

[1]: https://developers.cloudflare.com/workers/platform/limits/ "Cloudflare Workers limits"
[2]: https://developers.cloudflare.com/workers-ai/platform/pricing/ "Cloudflare Workers AI pricing"
[3]: https://developers.cloudflare.com/kv/platform/limits/ "Cloudflare Workers KV limits"
[4]: https://developers.cloudflare.com/queues/platform/pricing/ "Cloudflare Queues pricing"
[5]: https://developers.cloudflare.com/queues/platform/limits/ "Cloudflare Queues limits"
[6]: https://developers.cloudflare.com/workers-ai/models/flux-1-schnell/ "Workers AI FLUX.1 schnell model"
[7]: https://developers.cloudflare.com/workers-ai/models/llama-3.1-8b-instruct-fp8/ "Workers AI Llama 3.1 8B FP8 model"
[8]: https://developers.cloudflare.com/workers-ai/models/melotts/ "Workers AI MeloTTS model"
[9]: https://developers.cloudflare.com/workers-ai/models/whisper/ "Workers AI Whisper model"
[10]: https://developers.cloudflare.com/workers-ai/models/ "Workers AI model catalog"
