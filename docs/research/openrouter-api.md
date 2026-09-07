# OpenRouter API reference for an embedded agent loop

Verified against docs on 2026-09-07. Base URL `https://openrouter.ai/api/v1`. Sources read (all `.md` mirrors of the docs, plus two live public endpoints):

- https://openrouter.ai/docs/api_reference/authentication.md
- https://openrouter.ai/docs/api_reference/overview.md
- https://openrouter.ai/docs/api_reference/parameters.md
- https://openrouter.ai/docs/api_reference/streaming.md
- https://openrouter.ai/docs/api_reference/limits.md
- https://openrouter.ai/docs/api_reference/errors-and-debugging.md
- https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion.md (OpenAPI)
- https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties.md
- https://openrouter.ai/docs/api/api-reference/endpoints/list-all-endpoints-for-a-model.md
- https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key.md
- https://openrouter.ai/docs/api/api-reference/generations/get-request-&-usage-metadata-for-a-generation.md
- https://openrouter.ai/docs/guides/features/tool-calling.md
- https://openrouter.ai/docs/guides/overview/multimodal/image-understanding.md
- https://openrouter.ai/docs/guides/overview/multimodal/pdfs.md
- https://openrouter.ai/docs/guides/best-practices/reasoning-tokens.md
- https://openrouter.ai/docs/guides/best-practices/prompt-caching.md
- https://openrouter.ai/docs/guides/routing/provider-selection.md
- https://openrouter.ai/docs/guides/features/structured-outputs.md
- https://openrouter.ai/docs/cookbook/administration/usage-accounting.md
- Live: `GET https://openrouter.ai/api/v1/models` and `GET /api/v1/models/anthropic/claude-sonnet-4.5/endpoints` (no key required)

"Docs silent" below means: not stated on any page above. Model ids seen live today (e.g. `anthropic/claude-fable-5.1`) are quoted as observed.

## 1. Auth and key validation

- Header: `Authorization: Bearer <OPENROUTER_API_KEY>`; body `Content-Type: application/json`.
- Optional attribution headers, verbatim from the auth page: `HTTP-Referer` ("Site URL for rankings on openrouter.ai") and `X-OpenRouter-Title` ("Site title for rankings on openrouter.ai"). The overview page adds: "`X-OpenRouter-Title`: Sets/modifies your app's title (`X-Title` also accepted)".
- Cheap key check: `GET /api/v1/key` (there is no `/auth/key`; the limits page says "To check the rate limit or credits left on an API key, make a GET request to `https://openrouter.ai/api/v1/key`"). 401 = "Missing Authentication header". Response (OpenAPI example):

```json
{ "data": {
  "label": "sk-or-v1-au7...890",
  "limit": 100, "limit_remaining": 74.5, "limit_reset": "monthly",
  "usage": 25.5, "usage_daily": 25.5, "usage_weekly": 25.5, "usage_monthly": 25.5,
  "byok_usage": 17.38, "byok_usage_daily": 17.38, "byok_usage_weekly": 17.38, "byok_usage_monthly": 17.38,
  "is_free_tier": false, "is_management_key": false, "is_provisioning_key": false,
  "include_byok_in_limit": false, "creator_user_id": "user_2dHFtVWx2n56w6HkM0000000000",
  "expires_at": "2027-12-31T23:59:59Z",
  "rate_limit": { "requests": 1000, "interval": "1h", "note": "This field is deprecated and safe to ignore." } } }
```

Limits page annotations: `limit: number | null` ("Credit limit for the key, or null if unlimited"), `limit_remaining: number | null`, `usage` = "credits used (all time)", `usage_daily` = "current UTC day", `is_free_tier` = "Whether the user has paid for credits before". Docs silent on whether `/key` counts against any rate limit.

## 2. Chat completions: `POST /api/v1/chat/completions`

### 2.1 Request (overview page TypeScript, abridged to fields an agent loop uses)

```typescript
type Request = {
  messages?: Message[]; prompt?: string; model?: string;
  response_format?: ResponseFormat; stop?: string | string[]; stream?: boolean;
  plugins?: Plugin[];
  max_tokens?: number; // Range: [1, context_length)
  temperature?: number; // Range: [0, 2]
  tools?: Tool[]; tool_choice?: ToolChoice;
  seed?: number; top_p?: number; top_k?: number; ...
  models?: string[]; route?: 'fallback'; provider?: ProviderPreferences;
  user?: string; // A stable identifier for your end-users. Used to help detect and prevent abuse.
  debug?: { echo_upstream_body?: boolean }; // streaming only
};
```

OpenAPI adds `max_completion_tokens` ("Maximum tokens (deprecated, use max_completion_tokens)" is the note on `max_tokens`), `parallel_tool_calls` (bool|null; parameters page: default `true`), `reasoning`, `reasoning_effort`, `stream_options` (`include_usage` is "Deprecated: This field has no effect"), request-level `cache_control` (`AnthropicCacheControlDirective`, see section 4). `temperature` default 1.0. Parameters page: "When a sampling parameter is absent from your request, OpenRouter omits it upstream rather than substituting a hardcoded value, so the provider applies its own default."

### 2.2 Messages and content parts

Overview page types (note the `tool` role shape):

```typescript
type Message =
  | { role: 'user' | 'assistant' | 'system'; content: string | ContentPart[]; name?: string }
  | { role: 'tool'; content: string; tool_call_id: string; name?: string };
type TextContent = { type: 'text'; text: string };
type ImageContentPart = { type: 'image_url'; image_url: { url: string; /* URL or base64 encoded image data */ detail?: string; /* Optional, defaults to "auto" */ } };
```

OpenAPI content-part discriminator on `type`: `text`, `image_url`, `file`, `input_audio`, `input_video`, `video_url`. Assistant message properties: `content`, `tool_calls`, `reasoning` (string|null), `reasoning_details`, `refusal`, `annotations` (PDF page). Tool message: `role: tool`, `tool_call_id` (required), `content` string or content-item array.

Images (image-understanding page): "The `image_url` can either be a URL or a base64-encoded image." Data-URL form from the examples: `data:image/jpeg;base64,{base64_image}`. Supported content types: `image/png`, `image/jpeg`, `image/webp`, `image/gif`. "we recommend sending the text prompt first, then the images." Number of images per request "varies per provider and per model." `detail` enum (OpenAPI): `auto | low | high | original` ("`original` is an OpenRouter extension ... downgraded to `high` for providers that lack an original-resolution tier"). Docs silent on byte/pixel size limits (typed errors `image_too_large`, `payload_too_large` (413) exist but no numbers).

PDF / file part (pdfs page, verbatim):

```json
{ "type": "file", "file": { "filename": "document.pdf", "file_data": "https://bitcoin.org/bitcoin.pdf" } }
```

OpenAPI: `file_data` = "File content as base64 data URL or URL" (`data:application/pdf;base64,...`), also `file_id` = "File ID for previously uploaded files". Engine selection via plugin:

```json
{ "plugins": [ { "id": "file-parser", "pdf": { "engine": "mistral-ocr" } } ] }
```

`PDFParserEngine` enum: `mistral-ocr | native | cloudflare-ai` (plus deprecated `pdf-text`, "automatically redirected to `cloudflare-ai`"). Pricing constants in the page source: `MISTRAL_OCR_COST = 2` and `MISTRAL_OCR_US_COST = 2.2` USD "per 1,000 pages"; `cloudflare-ai` is free markdown conversion; `native` is "Only available for models that support file input natively" and charged as input tokens. Default: "If you don't explicitly specify an engine, OpenRouter will default first to the model's native file processing capabilities, and if that's not available, we will use the `mistral-ocr` engine." OCR forwards "at most **8 images per PDF**"; text is preserved in full. The parsed result comes back as `message.annotations` and can be resent to skip re-parsing (hash-keyed):

```json
{ "type": "file", "file": { "hash": "abc123...", "name": "document.pdf",
  "content": [ { "type": "text", "text": "Parsed text content..." },
               { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } } ] } }
```

If every provider fails after parsing, the same array appears at `error.metadata.file_annotations`. `native` produces no annotations. Docs silent on max PDF size / page count.

### 2.3 Tools

```typescript
type Tool = { type: 'function'; function: { name: string; description?: string; parameters: object /* JSON Schema */ } };
type ToolChoice = 'none' | 'auto' | { type: 'function'; function: { name: string } };
```

OpenAPI `ChatToolChoice` additionally allows the string `required`. Assistant reply (tool-calling page):

```json
{ "role": "assistant", "content": null,
  "tool_calls": [ { "id": "call_abc123", "type": "function",
    "function": { "name": "search_gutenberg_books", "arguments": "{\"search_terms\": [\"James\", \"Joyce\"]}" } } ] }
```

`arguments` is a "JSON string" (OpenAPI). Then: `{ "role": "tool", "tool_call_id": "call_abc123", "content": "[{\"id\": 4300, \"title\": \"Ulysses\", ...}]" }`. "The LLM responds with a finish reason of `tool_calls`, and a `tool_calls` array." `ChatFinishReasonEnum`: `tool_calls | stop | length | content_filter | error | null`; `native_finish_reason` is the raw provider value. `parallel_tool_calls: false` = "the model will only request one tool call at a time". Tool-capable models: filter `supported_parameters=tools`.

### 2.4 Streaming (`stream: true`, SSE)

- Lines are `data: <json>`; the stream ends with `data: [DONE]`. Keep-alive comment lines `: OPENROUTER PROCESSING` arrive at any time; skip lines starting with `:` before `JSON.parse`.
- Chunk: `object: "chat.completion.chunk"`, `choices[].delta` with `content`, optional `role`, optional `tool_calls: ToolCall[]`, optional `reasoning_details`; `choices[].finish_reason` / `native_finish_reason` on the last content chunk.
- Final usage chunk (verbatim): "every stream ends with an extra chunk that carries the `usage` object for the request, sent just before the `[DONE]` message ... the usage chunk contains one choice with a content-free `delta` that repeats the `finish_reason`":

```
data: {"id":"gen-abc123",...,"choices":[{"index":0,"delta":{"content":"","role":"assistant"},"finish_reason":"stop","native_finish_reason":"stop"}]}
data: {"id":"gen-abc123",...,"choices":[{"index":0,"delta":{"content":"","role":"assistant"},"finish_reason":"stop","native_finish_reason":"stop"}],"usage":{...}}
data: [DONE]
```

"the terminal `finish_reason` appears twice ... treat the usage chunk as an accounting frame rather than a second terminal event."
- Tool-call deltas: the only doc example accumulates `data.choices[0].delta.tool_calls` into an array and acts when finish_reason is `tool_calls`. Docs are silent on the partial-delta shape (whether `index`/`id` arrive once and `function.arguments` arrives in fragments, OpenAI-style); a spec must treat that as OpenAI-compatible behaviour to be verified by test, not by docs. (The example checks `delta.finish_reason`, but every other page puts `finish_reason` on the choice.)
- Cancellation: aborting the connection stops billing only for listed providers (OpenAI, Anthropic, Fireworks, DeepSeek, xAI, ... ); not for Google, AWS Bedrock, Groq, Mistral, etc. "For non-streaming requests or unsupported providers, the model will continue processing and you will be billed for the complete response."

### 2.5 Usage object

`usage: {include: true}` is deprecated: "Full usage details are now always included automatically in every response." Counts use "the model's native tokenizer". Shape (overview page):

```typescript
type ResponseUsage = {
  prompt_tokens: number; completion_tokens: number; total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number; cache_write_tokens?: number; audio_tokens?: number; video_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number; audio_tokens?: number; image_tokens?: number };
  cost?: number; /** Cost in credits */ is_byok?: boolean;
  cost_details?: { upstream_inference_cost?: number; upstream_inference_prompt_cost: number; upstream_inference_completions_cost: number; server_tool_cost?: number | null };
  server_tool_use?: { web_search_requests?: number };
};
```

Example from the usage page: `"cost": 0.95, "cost_details": {"upstream_inference_cost": 19}, "prompt_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 100, "audio_tokens": 0}`. "`cached_tokens` is the number of tokens that were *read* from the cache. `cache_write_tokens` ... *written* to the cache (only returned for models with explicit caching and cache write pricing)." Reasoning tokens "are considered output tokens and charged accordingly."

### 2.6 Reasoning

```json
{ "reasoning": {
    "effort": "high",      // "max", "xhigh", "high", "medium", "low", "minimal" or "none" (OpenAI-style)
    "max_tokens": 2000,    // Specific token limit (Anthropic-style)  -- one of the two, not both
    "exclude": false,      // Set to true to exclude reasoning tokens from response
    "enabled": true } }    // Default: inferred from `effort` or `max_tokens`
```

(The OpenAPI request schema lists only `effort` and `summary` under `reasoning`; `max_tokens`/`exclude`/`enabled` are documented on the guide page. `reasoning_effort` is a top-level shorthand.) `effort` "Currently supported by OpenAI reasoning models (o1 series, o3 series, GPT-5 series) and Grok models"; `max_tokens` by "Gemini thinking models", "Anthropic reasoning models", "Some Alibaba Qwen thinking models". Each is translated to the other: Anthropic `budget_tokens = max(min(max_tokens * ratio, 128000), 1024)` with ratio max/xhigh 0.95, high 0.8, medium 0.5, low 0.2, minimal 0.1; `"none"` disables. `"enabled": true` = "medium" effort. `"exclude": true` = model still reasons, nothing returned. Models advertise a `reasoning` object in `/models`: `{"supported_efforts": [...], "default_effort": "medium", "default_enabled": true, "mandatory": true, "supports_max_tokens"?: true}`; when `mandatory`, "do not send `effort: "none"` — the model rejects it".

Response: `message.reasoning` (string) and `message.reasoning_details[]` with `type` in `reasoning.text` (`text`, `signature`), `reasoning.summary` (`summary`), `reasoning.encrypted` (`data`), each with `id`, `format` (e.g. `anthropic-claude-v1`, `google-gemini-v1`), `index`. Streaming: `choices[].delta.reasoning_details`. For tool loops pass the assistant message back with `reasoning_details: message.reasoning_details  # Pass back unmodified` so Claude can "continue building that existing response".

### 2.7 Provider routing (`provider` object)

| field | type | default |
|---|---|---|
| `order` | string[] | - (provider slugs to try in order) |
| `allow_fallbacks` | boolean | `true` |
| `require_parameters` | boolean | `false` |
| `data_collection` | "allow" \| "deny" | "allow" |
| `zdr` | boolean | - |
| `only` / `ignore` | string[] | - |
| `quantizations` | string[] | - |
| `sort` | "price" \| "throughput" \| "latency" or `{by, partition: "model"\|"none"}` | - |
| `preferred_min_throughput` / `preferred_max_latency` | number or `{p50,p75,p90,p99}` | - |
| `max_price` | `{prompt, completion, image, request, audio}` (USD per million tokens) | - |

"With the default routing strategy, providers that don't support all the LLM parameters specified in your request can still receive the request, but will ignore unknown parameters. When you set `require_parameters` to `true`, the request won't even be routed to that provider." Suffixes: `:nitro` (throughput sort + priority tier), `:floor` (price sort + flex tier), `:free`.

### 2.8 Errors

```typescript
type ErrorResponse = { error: { code: number; message: string; metadata?: Record<string, unknown> } };
```

Status codes (verbatim list): 400 "Bad Request (invalid or missing params, CORS)"; 401 "Invalid credentials (OAuth session expired, disabled/invalid API key)"; 402 "Your account or API key has insufficient credits. Add more credits and retry the request."; 403 "Forbidden (insufficient permissions, guardrail block, or moderation flag)"; 408 "Your request timed out"; 429 "You are being rate limited"; 502 "Your chosen model is down or we received an invalid response"; 503 "There is no available model provider that meets your routing requirements". `error.metadata.error_type` is the typed code to switch on: `authentication`(401), `payment_required`(402), `permission_denied`(403), `rate_limit_exceeded`(429), `provider_overloaded`(503), `provider_unavailable`(502), `context_length_exceeded`/`max_tokens_exceeded`/`invalid_request`/`invalid_prompt`/`content_policy_violation`/`refusal`/`invalid_image`/`image_too_large`/`unsupported_image_format`(400), `not_found`(404), `payload_too_large`(413), `timeout`(504), `server`/`unmapped`(500). `error.metadata.provider_code` carries the upstream code (omitted on 500s). Moderation: `metadata = { reasons: string[]; flagged_input: string; provider_name: string; model_slug: string }`. "In some cases, you may still be charged for the prompt processing cost by the upstream provider, even if no content is generated."

Mid-stream (HTTP stays 200):

```
data: {"id":"gen-abc123","object":"chat.completion.chunk","created":1234567890,"model":"openai/gpt-4o","provider":"OpenAI","error":{"code":429,"message":"Rate limit exceeded","metadata":{"error_type":"rate_limit_exceeded"}},"choices":[{"index":0,"delta":{"content":""},"finish_reason":"error"}]}
```

```typescript
type MidStreamError = { error: { code: number; message: string; metadata?: { error_type: string; provider_code?: string } };
                        choices: [{ finish_reason: 'error'; native_finish_reason?: string }] };
```

A non-streaming provider failure after partial output can also surface as `choices[0].finish_reason: "error"` with `choices[0].error` (overview `NonStreamingChoice.error?: ErrorResponse`).

## 3. Models

`GET /api/v1/models` (no auth needed live). Query params: `category`, `supported_parameters` (comma-separated), `input_modalities`, `output_modalities`, `sort`, `offset`, `limit`, `q`; paginated (`next: /api/v1/models?offset=500&limit=500`). Model object, live sample trimmed (schema fields confirmed):

```json
{ "id": "anthropic/claude-sonnet-4.5", "canonical_slug": "anthropic/claude-4.5-sonnet-20250929",
  "name": "Anthropic: Claude Sonnet 4.5", "created": 1759161676, "description": "...", "context_length": 1000000,
  "architecture": { "modality": "text+image+file->text", "input_modalities": ["text","image","file"],
                    "output_modalities": ["text"], "tokenizer": "Claude", "instruct_type": null },
  "pricing": { "prompt": "0.000003", "completion": "0.000015", "web_search": "0.01",
               "input_cache_read": "0.0000003", "input_cache_write": "0.00000375", "input_cache_write_1h": "0.000006",
               "overrides": [ { "min_prompt_tokens": 200000, "prompt": "0.000006", "completion": "0.0000225", ... } ] },
  "top_provider": { "context_length": 1000000, "max_completion_tokens": 64000, "is_moderated": true },
  "per_request_limits": null,
  "supported_parameters": ["include_reasoning","max_completion_tokens","max_tokens","reasoning","response_format","stop","structured_outputs","temperature","tool_choice","tools","top_k","top_p"],
  "default_parameters": { "temperature": 1, "top_p": 1, "top_k": null, ... },
  "reasoning": { ... }, "knowledge_cutoff": "2025-01-31", "expiration_date": null,
  "links": { "details": "/api/v1/models/anthropic/claude-4.5-sonnet-20250929/endpoints" } }
```

- Pricing values are **strings**, "Price in USD per token for prompt (input) processing" / "per token for completion (output) generation"; `image` = "Price in USD per input image"; `request` = per request. Other keys seen live: `internal_reasoning`, `audio`, `audio_output`, `image_output`, `input_audio_cache`. `overrides[]` applies tiered prices above `min_prompt_tokens` (docs silent on this field; observed live). Absent key = not priced (many models omit `image`, `request`).
- `input_modalities` enum: `text, image, file, audio, video` — `file` is listed for PDF-native models (live: Gemini, OpenAI, Anthropic, Grok entries carry `file`).
- `supported_parameters` values seen live: `tools, tool_choice, parallel_tool_calls, reasoning, reasoning_effort, include_reasoning, structured_outputs, response_format, max_tokens, max_completion_tokens, temperature, top_p, top_k, stop, seed, logprobs, top_logprobs, logit_bias, min_p, top_a, frequency_penalty, presence_penalty, repetition_penalty, prediction, verbosity, web_search_options`.
- `top_provider.max_completion_tokens` may be `null`.

`GET /api/v1/models/{author}/{slug}/endpoints` exists. `data`: `id, name, created, description, architecture, endpoints[]`. Per endpoint (live): `name, model_id, model_name, context_length, pricing (same string shape plus "discount": 0), provider_name, tag, quantization, max_completion_tokens, max_prompt_tokens, supported_parameters, supports_tool_choice: {none, auto, required, function}, supports_implicit_caching, status (0 = ok in example), uptime_last_30m/5m/1d, latency_last_30m, throughput_last_30m` (the latter two `{p50,p75,p90,p99}` or null).

## 4. Prompt caching

Inspect via `usage.prompt_tokens_details.cached_tokens` / `cache_write_tokens`, or `/generation` (`cache_discount`, `native_tokens_cached`). Sticky routing keeps follow-ups on the same provider.

- **Anthropic**: explicit per-block breakpoints, "limit of four explicit breakpoints":

```json
{ "role": "system", "content": [ { "type": "text", "text": "HUGE TEXT BODY", "cache_control": { "type": "ephemeral" } } ] }
```

  or automatic: a top-level request field `"cache_control": { "type": "ephemeral" }` (optionally `"ttl": "1h"`) — "automatically applies the cache breakpoint to the last cacheable block and advances it forward as conversations grow"; supported on Anthropic, Vertex, Azure, Bedrock, Claude on AWS. Writes 1.25x input (5-min TTL) or 2x (1-hour), reads 0.1x. Minimum cacheable prompt: 1,024 tokens (Sonnet 4/4.5/4.6, Opus 4/4.1) or 4,096 (Opus 4.5+, Haiku 4.5). `cache_control` is also accepted on tool definitions (OpenAPI `ChatFunctionTool.cache_control`).
- **OpenAI**: "automated and does not require any additional configuration. There is a minimum prompt size of 1024 tokens." Reads 0.25x–0.5x; writes free before GPT-5.6, 1.25x from GPT-5.6. Optional explicit `prompt_cache_breakpoint` on a text block + request-level `prompt_cache_options: {mode: "explicit", ttl: "30m"}`; a `cache_control` block is auto-translated to a breakpoint for OpenAI (TTL dropped).
- **Google Gemini**: "Gemini 2.5 series models and newer support implicit caching ... no manual setup or additional `cache_control` breakpoints required" (min 1,024 tokens Flash / 4,096 Pro per the rendered page; TTL "on average 3-5 minutes"); reads 0.25x, no write cost. Explicit `cache_control` also works for Gemini; "OpenRouter will use only the last breakpoint".
- DeepSeek, Grok, Moonshot, Groq, Z.AI: automatic, no config.

## 5. Rate limits and free tier

- Free variants only (id ending `:free`): 20 requests/minute; 50 requests/day if lifetime credits purchased < 10, 1,000/day if >= 10. Paid variants have "no platform-level request cap" (only Cloudflare DDoS protection). Docs silent on any per-key RPM/TPM for paid models; upstream 429s are passed through.
- 402 comes from a negative account balance ("including for free models") or an exhausted per-key `limit`; check `GET /api/v1/key` -> `limit_remaining`.
- 429 responses from OpenRouter carry `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`; "Successful inference responses do not include `X-RateLimit-*` headers." `Retry-After` present "when every attempted provider returned a retry hint". Advice: exponential backoff. A 429 after streaming starts arrives as the mid-stream error chunk (section 2.8).

## 6. Generation lookup: `GET /api/v1/generation?id=<id>`

Bearer auth required; `id` is the `id` from the completion (`gen-...`). Error codes listed: 401, 402, 404, 429, 500, 502, 524, 529. Docs silent on how soon after completion the record is available. Response (OpenAPI example, all `data` fields):

```json
{ "data": { "id": "gen-3bhGkxlo4XFrqiabUM7NDtwDzWwG", "upstream_id": "chatcmpl-...",
  "total_cost": 0.0015, "cache_discount": null, "upstream_inference_cost": 0.0012, "usage": 0.0015, "is_byok": false,
  "created_at": "2024-07-15T23:33:19.433273+00:00", "model": "sao10k/l3-stheno-8b", "provider_name": "Infermatic",
  "streamed": true, "cancelled": false, "latency": 1250, "moderation_latency": 50, "generation_time": 1200,
  "finish_reason": "stop", "native_finish_reason": "stop",
  "tokens_prompt": 10, "tokens_completion": 25,
  "native_tokens_prompt": 10, "native_tokens_completion": 25, "native_tokens_completion_images": 0,
  "native_tokens_reasoning": 5, "native_tokens_cached": 3,
  "num_media_prompt": 1, "num_input_audio_prompt": 0, "num_media_completion": 0, "num_search_results": 5, "num_fetches": 0,
  "web_search_engine": "exa", "origin": "https://openrouter.ai/", "external_user": "user-123", "api_type": "completions",
  "app_id": 12345, "preset_id": "...", "router": "openrouter/auto", "provider_responses": null,
  "user_agent": "Mozilla/5.0", "http_referer": "https://openrouter.ai/", "data_region": "global",
  "workspace_id": "...", "service_tier": "priority", "session_id": null, "response_cache_source_id": null } }
```

`total_cost` = "Total cost of the generation in USD"; `usage` = "Usage amount in USD"; `latency`/`generation_time` in milliseconds. Since `usage.cost` is already on every response, this endpoint is for after-the-fact audit (`cache_discount`, native token counts, `cancelled`).

## 7. Structured output (for completeness)

`response_format: { type: "json_schema", json_schema: { name, strict: true, schema } }` (or `{type: "json_object"}`); works with `stream: true`; gate on `supported_parameters` containing `structured_outputs` / `response_format`, and set `provider.require_parameters: true` to avoid silent drops.
