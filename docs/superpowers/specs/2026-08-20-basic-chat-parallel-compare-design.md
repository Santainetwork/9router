# Basic Chat Parallel Compare Design

**Date:** 2026-08-20
**Status:** Approved design

## Goal

Add an ephemeral Compare mode to Basic Chat. A user selects 2–4 models, sends one prompt, and sees independently streaming responses in parallel. Compare runs never create, modify, or persist normal chat sessions.

## Scope

### Included

- Normal and Compare modes in the existing Basic Chat page.
- Selection of 2–4 available models across connected providers.
- One prompt and the existing image attachments sent to every selected model.
- One independent SSE request, result state, abort controller, retry action, error, metadata, and footer per model.
- Responsive result layout: columns on wide screens, stacked cards on narrow screens.
- Stop all and per-card stop/retry controls.
- Results stored only in React memory and discarded on reload, mode exit, or a new compare run.

### Excluded

- Compare history or localStorage persistence.
- Hidden normal chat sessions.
- Server-side aggregate/fan-out endpoint.
- Search, ranking, voting, automatic judging, or result merging.
- Changes to the existing normal chat workflow or global footer settings.

## User Experience

A Chat/Compare mode control appears in the Basic Chat header. Chat remains the default and preserves the current provider/model selectors, history, and clear controls.

Compare replaces the single-model selector with a multi-model picker backed by the existing provider/model catalog. Selected models appear as removable chips. Sending is enabled only with 2–4 models and non-empty text or an image attachment. The composer indicates the selected model count.

On send, the current prompt is shown once above a responsive result grid. Each model card shows provider/model identity, streaming text, status, elapsed/usage/footer metadata, and its own stop or retry action. One failed request does not stop other cards. Stop all aborts only currently running compare requests.

Starting another compare run replaces the current ephemeral prompt and results. Returning to Chat discards Compare state after aborting active Compare requests. Reloading the page also discards it.

## Architecture

Keep orchestration client-side because the existing public endpoint already accepts one model per request and the feature needs independent cancellation and failures. No backend change is required.

Extract the transport-neutral streaming request from the current session-writing `runStream` into a small helper that accepts:

- model, request messages, API key, and `AbortSignal`
- callbacks for text chunks and response metadata
- completion/error return values

Normal Chat continues to adapt callbacks into session updates. Compare adapts them into an in-memory result map keyed by model ID. This avoids fake sessions while sharing SSE parsing, response-header metadata, usage normalization, and error handling.

Compare state contains:

- `mode`: `chat` or `compare`
- `compareModelIds`: ordered unique model IDs, maximum four
- `compareRun`: prompt, copied attachments, and one result per selected model
- `compareAbortControllers`: a ref-only map keyed by model ID

Compare state is deliberately absent from `STORAGE_KEYS` and every session mutation path.

## Data Flow

1. User selects 2–4 unique models from `modelIndex`.
2. Send snapshots the draft, attachments, models, and current API key.
3. The client creates one pending result per model and clears the composer.
4. `Promise.allSettled` starts one existing dashboard completion request per model through `/api/dashboard/chat/completions` with `stream: true`.
5. Each request updates only its card through callback-based state updates.
6. Completion records status and response metadata. Failure records only that card's error.
7. Retry replaces that model card's result and resends the same snapshotted prompt/attachments.
8. Stop aborts the selected controller. Stop all aborts every active controller.

## Error and Cancellation Semantics

- HTTP and stream errors become visible card-level errors.
- Malformed SSE chunks remain ignored, matching current Chat behavior.
- An aborted card becomes `stopped`, preserving received partial text.
- Empty successful streams become errors.
- Model catalog changes remove unavailable selections before sending.
- Mode exit and component unmount abort all active Compare requests.
- Compare errors do not use the page-wide normal Chat error banner.

## Accessibility and Responsive Behavior

- Mode controls expose pressed/selected state.
- Multi-model choices are keyboard-operable checkboxes with model and provider labels.
- Stop/retry buttons have model-specific accessible labels.
- Status changes use concise visible labels; the result region uses non-disruptive live status semantics.
- Wide screens show up to two result columns for readable text. Narrow screens stack cards.

## Testing and Acceptance

### Runnable checks

- Streaming helper test: split SSE chunks, usage, headers, malformed lines, HTTP failure, abort, and empty stream.
- Compare-state tests: 2–4 selection limit, uniqueness, independent updates, retry reset, stop state, and no session mutation.
- Existing model-restore check remains passing.
- Production build succeeds.

### Real acceptance path

Using the authenticated Basic Chat route and real `/api/dashboard/chat/completions` boundary:

1. Select two working models, send one prompt, observe both cards stream and finish independently.
2. Select one invalid model plus one working model, observe isolated failure and successful completion.
3. Stop one active card, observe other cards continue.
4. Retry one card, observe only that card restart with the same prompt.
5. Confirm History and `basic-chat.sessions` are unchanged after send, retry, stop, mode switch, and reload.
6. Confirm selection limits, keyboard controls, mobile stacking, global footer rendering, and optional API-key behavior.
7. Deploy gracefully and verify active connections are not interrupted using the established production drain procedure.

## Deliberate Limits

`ponytail:` Compare is one-turn and ephemeral. Add multi-turn compare history only when users need longitudinal comparisons; that requires a separate persistence model and UX.
