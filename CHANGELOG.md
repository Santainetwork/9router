# v0.5.91 (2026-09-26)

## Features
- **Providers**: add Token Harbor provider and four OpenAI-compatible aggregator providers (dahl, atria, agnes, bai)
- **Claude**: forward `x-claude-code-session-id` on OAuth requests; merge client `anthropic-beta` flags and forward rate-limit headers; return thinking text to OpenAI-format clients
- **Codex**: add GPT-6 Sol and Luna support
- **CLI Tools**: support multiple model profiles for Codex CLI
- **Hermes**: multi-role model config (delegation + auxiliary slots)
- **OpenCode Go**: complete the Go catalog (40 models) with auto-fetch + family endpoint regex
- **Usage**: show and redeem free limit resets for cc accounts
- **Cline**: expose the `cline-free/*` tier and price it at zero
- **Combos**: display vision adapter models in an ordered table view

## Fixes
- **Claude**: decloak tool names when `toolNameMap` misses (#4342); update spoofed cli version to 2.1.280 to support Opus 5.5
- **Providers API**: make POST `/api/providers` O(1) and refuse silent key overwrite (#4350)
- **Capabilities**: stop caching the catalog source per module copy (#4351)
- **OAuth**: stop Zed paste-token crash and add IDE auto-import (#4359)
- **Dashboard**: resolve combo limits with the server's capabilities (#4360); lazy-load charts and `marked`, preload in background on idle
- **Responses**: carry the streamed output items in `response.completed` (#4307)
- **STT**: dispatch live-API-only Gemini models over the Live WebSocket transport (#4006)
- **Gemini**: guard terminal model turns and unresponded functionCalls in `normalizeGeminiContents`
- **Command Code**: replay raw byte chunks to preserve all NDJSON lines
- **Translator**: stop emitting empty `<think>` markers into OpenAI content
- **CLI Tools**: refresh Codex settings after apply (#4347); keep existing `ANTHROPIC_AUTH_TOKEN` when applying Claude settings
- **Tray**: native arm64 macOS menubar binary, no Rosetta required
- **CLI**: filter model selector by active connections and noAuth providers
- **Usage**: key live byApiKey stats by full api key to prevent team-key collision and preserve API key usage attribution
- **Tailscale**: cap enable-flow health wait at 20s

# v0.5.86 (2026-09-23)

## Features
- **Xiaomi MiMo**: server-assisted desktop login for headless/Docker deployments, five account clusters (cn/sgp/ams/ru/in), and v2.6 pro/flash/pro-ultraspeed models with dual-route (account service vs. cloud API)
- **Claude**: add Claude Opus 5.5 support
- **i18n**: translate React text rewrites via characterData mutation observer

## Fixes
- **Proxy Pools**: keep request headers intact through Vercel/Cloudflare/Deno relays (spreading a `Headers` instance yielded `{}`, dropping auth and content-type)
- **Xiaomi MiMo login**: keep the session in the httpOnly cookie only, require dashboard auth on the proxy branch, and stop forwarding authorization headers upstream

# v0.5.85 (2026-09-22)

## Features
- **System One**: add `/v1/systemone` decision endpoint for Jev models (OpenCode Zen and OpenRouter lanes), wire into sidebar and Media Providers page with interactive probe testing
- **CLI Tools**: add dynamic configuration, settings APIs, and official logos for Pi, OMP, Crush, ForgeCode, Smelt, and CodeWhale
- **Analytics & Usage**: add Requests mode, provider/model breakdown charts, All Time period filter, and refined overview cards
- **Combos**: add Cursor/Claude Default presets; support bulk select/delete and bulk strategy changes (Fallback / Round Robin / Fusion)
- **Model Capabilities**: expose model capability metadata on `/v1/models` and aggregate capabilities across combo targets
- **OpenCode Zen & MiMo**: add OpenCode Zen (`opencode-zen`) provider with free-tier fingerprint; switch default vision fallback to MiMo V2.6 Flash Free
- **Qoder CN**: add `qoder-cn` provider for qoder.com.cn with OAuth flow, COSY protocol, and CN gateway routing

## Fixes
- **Translator**: map Claude `refusal` stop_reason to `content_filter` and surface explanation; strip replayed reasoning fields for Groq, Mistral, and Cerebras (#4220)
- **Antigravity**: drop requestType `agent` to avoid false 429 `RESOURCE_EXHAUSTED`; separate weekly and short-window (5-hour) quotas and deduplicate dashboard rows
- **Responses API**: report usage on `response.completed` so clients can auto-compact (#3432)
- **Hugging Face**: migrate to Inference Providers router (`router.huggingface.co`), expand image models catalog, and add STT route
- **Qoder**: prevent signed request replay (`403/103 Duplicate request`), handle code 110 billing blocks, and preserve upstream SSE error status
- **Performance**: bound usage `lastUsed` scan to a 2-day window; map large budget tokens to `max` reasoning tier
- **Docker**: publish verified multi-platform images (linux/amd64 and linux/arm64) with configurable apk build mirrors

# v0.5.81 (2026-09-18)

## Features
- Xiaomi MiMo Token Plan: region selector (Singapore / China / Europe) — keys are cluster-specific
- Antigravity: risk confirmation dialog before first connection
- Gemini CLI: surface upstream retry delay on 429 errors

## Fixes
- MITM: cannot kill process on macOS under sudo (lsof not found in PATH)
- Stream: false-positive stall timeout on Claude reasoning / Kiro responses
- Tunnel: cannot re-enable after disable (stuck state)
- Tunnel: cloudflared error messages now include log tail for easier debugging
- Language switcher: applies selected locale immediately on close (#1234)
- Antigravity OAuth: metadata now matches the official client

## Improvements
- Gemini CLI: bump engine to 0.34.0
- Re-hide `qwen` (OAuth EOL) and `iflow` (not ready) providers

# v0.5.81-custom (2026-09-18)

## Fixes
- **Cursor**: stop AgentService empty turns (`OUT 0`) and silent hangs — fold system prompts instead of `custom_system_prompt`, send `ModelDetails`, read Composer/Grok `thinking_delta`, ack request-context without echoing MCP tools, reject IDE execs so model can continue
- **RTK**: compress source-format `tool_result` / `role:tool` **before** translation for Cursor (translator rewrites those shapes); other providers keep post-translate pass unchanged

# v0.5.75-custom (2026-09-10)

## Features (Upstream v0.5.75)
- **Video**: add OpenRouter and Vertex AI (Veo) video generation on `/v1/videos/*` via a provider adapter layer; poll requests resolve their provider from `x-connection-id` or `?provider=`
- **Antigravity**: add weekly quota tracking (Gemini weekly / Claude & GPT weekly) and free-tier handling from `retrieveUserQuotaSummary` (#3892)
- **Codex**: add GPT Image 2.5, Flare and Sunburst image models with multi-image support; add the same ids to the OpenAI catalog
- **Qoder**: surface usage to all clients and stop inlining large attachments — images upload through `/api/v2/image/upload` like qodercli, oversized file blocks become stubs, context tier auto-escalates
- **OpenCode Go**: add newly published models (glm-5.3, kimi-k3, deepseek-flash, longcat-2.0, hy4-preview, hy3 on chat/completions; qwen3.8-max, qwen3.8-flash on `/messages`; grok-4.6, gpt-5.6-luna on Responses) and list `deepseek-v4.1-flash` first in the catalog
- **CLI tools**: group the model selector by provider with full-text search and manual custom model ID entry
- **CodeBuddy-CN**: replace `deepseek-v4-flash` with `deepseek-v4.1-flash`

## Fixes (Upstream v0.5.75)
- **Tools**: scope Claude tool type defaulting to gateways declaring `requireClaudeToolType` — the global default broke Anthropic-compatible endpoints that only accept the legacy typeless tool shape (#3905)
- **Claude**: cap re-anchored `cache_control` at the 4-marker budget so a spent budget no longer 400s and triggers a full combo failover; wrap bare single-object content turns before the mid-conversation-system fold
- **Cline / Airforce**: unwrap the `{"success":true,"data":…}` envelope on non-stream chat completions (#3644); add the live Cline/ClinePass model catalog and refresh Airforce free models
- **Cline**: stop `workos:`-prefixing ClinePass API keys (401 on every request, #2333) and add clinepass token refresh
- **Kiro**: never send a top-level `systemPrompt` (`400 REQUEST_BODY_INVALID`); route requests through current runtime surfaces (#3776)
- **Codex**: strip Unicode-property tool schema patterns the validator rejects (#3922); restore the `Version` header and single-source the CLI version
- **DeepSeek**: keep Anthropic-only tool types when forwarding to `/anthropic/v1/messages`
- **Qoder**: drop the Responses usage plumbing from shared translator/handler code, which changed token accounting for every provider, not just Qoder
- **Antigravity**: normalize contents and handle intermediate tool responses; protect the OAuth token-refresh path from Google anti-abuse rate limits (#3813)
- **Providers**: clear stale connection health state (`modelLock_*`, `backoffLevel`, `rateLimitedUntil`, `errorCode`) when a connection is re-validated (#3810, #3830); remove the duplicate `qwen` provider that shadowed `alims-intl`
- **Video / Vertex**: reject job ids and model ids that would escape the request URL path (SSRF)
- **Usage**: parse the Fable weekly limit from `limits[]` instead of fabricating a row (#3847)
- **Auth**: set a 24h `maxAge` on the dashboard session cookie

## Custom Enhancements (SantaiNetwork AI Infrastructure)
- **In-Flight Concurrency & Limiter Engine**: FIFO request queue with zero-leak watchdog auto-decay and customizable concurrency limits per key and provider.
- **Electric Indigo & Neobrutalism UI**: Redesigned dashboard and `/usage-check` portal with shadcn/ui components and tactile Neobrutalist design.
- **Model Allowlist Wildcard**: Flexible prefix pattern matching (`hx/*`, `myr/*`, `*`) across API gateway and catalog endpoints.
- **Dedicated Public Endpoints**: Added `/v1/nosaver/chat/completions` and `/v1/nosaver/messages` to disable token reduction algorithms while preserving response footers.
- **Dynamic System Branding**: Instant gateway re-branding with SQLite persistence and live UI sync defaulting to `SantaiNetwork`.
- **Live Concurrency Tracker**: Real-time in-flight telemetry on `/usage-check` with fast-path sub-millisecond query (`?live=1`).

# v0.5.69 (2026-09-05)

## Features (Upstream v0.5.69)
- **Codex**: add GPT 6.0 Astra (`gpt-6-astra`) with vision, thinking and search capabilities
- **Usage**: add Claude Fable quota tracker support with weekly window normalization (`weekly fable (7d)`)
- **Dashboard**: group Antigravity Gemini and Claude quotas in Quota Tracker, prune stale hidden keys
- **OpenCode Go**: add `muse-spark-1.3-contributor` model and support parallel tool calls on Responses path (#3819)
- **Providers & Models**: align CodeBuddy-CN catalog/capabilities with server config; add GPT-5.6 Sol, Terra, Luna image aliases on Codex (#3806); refresh Qoder catalog with capability mapping and image pass-through
- **CLI tools**: replace Copilot MITM with VS Code extension setup guide
- **Gemini**: persist and replay `thoughtSignature` scoped by session namespace

## Fixes (Upstream v0.5.69)
- **Claude**: normalize adaptive auto effort (`output_config.effort`) (#3792)
- **Antigravity**: prevent Google anti-abuse rate limits during multi-account refresh (#3813)
- **Anthropic-compatible**: forward Claude beta flags to nodes fronting Anthropic (#3797)
- **Dashboard**: dynamic mode label for local/remote detection (#3801)
- **Codex**: format reset credit API errors cleanly (#3778)
- **Security**: guard cowork MCP tools probe against SSRF (#3783)
- **OpenCode Go**: track OpenCode Go quota (#3791) and send stable session headers (#3800)
- **Logger**: suppress noisy background token refresh logs
- **CLI**: export packed `.tgz` directly into workspace root instead of parent directory

## Custom Enhancements (SantaiNetwork AI Infrastructure)
- **In-Flight Concurrency & Limiter Engine**: FIFO request queue with zero-leak watchdog auto-decay and customizable concurrency limits per key and provider.
- **Electric Indigo & Neobrutalism UI**: Redesigned dashboard and `/usage-check` portal with shadcn/ui components and tactile Neobrutalist design.
- **Model Allowlist Wildcard**: Flexible prefix pattern matching (`hx/*`, `myr/*`, `*`) across API gateway and catalog endpoints.
- **Dedicated Public Endpoints**: Added `/v1/nosaver` to disable token reduction algorithms while preserving response footers.

# v0.5.65 (2026-09-03)

## Features
- **Fetch**: add Ollama Cloud web fetch provider
- **Gemini / Antigravity**: add Gemini 3.8 Flash support and bump IDE fingerprint to 2.11.0
- **Claude**: add Claude Fable 5.1 support (adaptive thinking with `output_config.effort`), bump Claude Code fingerprint to 2.1.258 for new-model access
- **Providers**: add client-side status filter (All / Active / Inactive / No connection) on the Providers dashboard; add max height and scroll for connection list
- **Providers & Models**: streamline tokenrouter model catalog down to 22 flagship/newest models and add missing provider icons; refresh Codebuddy-CN catalog (add hy4-preview/hy3/glm-5.3/kimi-k3-1, drop EOL glm-5.0/glm-4.7)
- **Models**: capability toggles (vision, reasoning) when adding custom models with upsert and live caps refresh
- **CLI tools**: support saving and managing custom API key presets
- **Quota**: add usage and rate-limit tracking for Groq via `x-ratelimit-*` headers
- **i18n**: complete Indonesian translation (1391 keys)

## Fixes
- **Security**: close SSRF guard bypasses in `ssrfGuard.js` (alternate IPv6 encodings, hostname trailing dots, wildcard DNS resolution check, safe redirect handling) (#3714)
- **Model markers**: strip the `[1m]` context marker Claude Code appends to model names (`claude-opus-5[1m]`) preventing model resolution failures (#3690)
- **Claude**: drop `server_tool_use` blocks carrying foreign IDs to avoid Anthropic 400 rejections; never anchor cache breakpoints on `defer_loading` tools (#3567)
- **Antigravity**: strike-break optimistic quota readings that keep 429ing by blocking the connection+model pair for 15m after 3 strikes (#3681); preserve client identity on model catalog requests (#3414)
- **Auth**: protect root `/responses` rewrite requiring API key validation in dashboardGuard
- **Chat & Docker**: return 503 Service Unavailable when all credentials are rate-limited; explicitly bundle `node-machine-id` into standalone Docker runtime image
- **OpenCode**: route Muse Spark models to `/zen/v1/responses` and declare vision support; filter inactive free model
- **Kiro**: preserve inline images as OpenAI-compatible `image_url` parts in OpenAI MITM; remove redundant top-level `systemPrompt` from payload
- **Usage**: read Responses-shape `cached_tokens` in `extractUsageFromResponse` for non-streaming traffic
- **Models**: support single model lookup with provider-prefixed IDs (e.g. `cc/claude-sonnet-5`)
- **Translator**: route Gemini thinking through `reasoning_effort` on OpenAI-compatible wire; convert `prefixItems` and ensure array items in Gemini schema sanitizer
- **UI**: apply persisted theme before first paint to prevent flash on reload; translate combo vision adapter label

# v0.5.59 (2026-08-29)

## Features
