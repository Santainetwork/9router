# Basic Chat Parallel Compare Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an ephemeral Basic Chat Compare mode that sends one prompt and existing image attachments to 2–4 selected models concurrently, streams each result independently, and never mutates or persists normal chat history.

**Architecture:** Keep fan-out in the browser. Extract the existing dashboard SSE request/parsing into `basicChatStream.js`, keep normal Chat session updates in `BasicChatPageClient.js`, and add Compare state plus abort-controller orchestration in that component. Add pure selection/state helpers in `basicChatCompare.js`; Compare state is never included in `STORAGE_KEYS`.

**Tech Stack:** Next.js 16, React 19, browser `fetch`/`ReadableStream`, existing `/api/dashboard/chat/completions` SSE endpoint, Node assert-based `.check.mjs` tests, Tailwind classes.

---

## File map

- Create: `src/app/(dashboard)/dashboard/basic-chat/basicChatStream.js` — transport-only SSE request, chunk parsing, headers, usage, abort/error propagation.
- Create: `src/app/(dashboard)/dashboard/basic-chat/basicChatCompare.js` — pure 2–4 model selection and Compare result state helpers.
- Modify: `src/app/(dashboard)/dashboard/basic-chat/BasicChatPageClient.js` — mode toggle, multi-model picker, Compare lifecycle, and result cards; normal Chat behavior remains session-backed.
- Create: `tests/basic-chat-stream.check.mjs` — split SSE, metadata, malformed chunks, HTTP failure, abort, empty stream checks.
- Create: `tests/basic-chat-compare.check.mjs` — selection limits, uniqueness, independent result updates, retry reset, stop state, and session isolation checks.
- Keep passing: `tests/basic-chat-model-restore.check.mjs`.
- Create: `docs/superpowers/plans/2026-08-20-basic-chat-parallel-compare.md` — this plan.

## Task 1: Add the transport-only streaming helper

**Files:**
- Create: `src/app/(dashboard)/dashboard/basic-chat/basicChatStream.js`
- Test: `tests/basic-chat-stream.check.mjs`

- [ ] **Step 1: Write the failing helper check.**

Use a data-URL import like `tests/basic-chat-model-restore.check.mjs`. The check must install a fake `fetch` or pass `fetchImpl` directly and cover a response whose stream splits these bytes across reads:

```js
const chunks = [
  'data: {"choices":[{"delta":{"content":"Hel"}}]}\\n\\n',
  'data: not-json\\n\\n',
  'data: {"choices":[{"delta":{"content":"lo"}}],"usage":{"prompt_tokens":2,"completion_tokens":3}}\\n',
  'data: [DONE]\\n\\n',
];
```

Assert `onText` receives `Hel` then `lo`, returned text is `Hello`, normalized usage is `{ promptTokens: 2, completionTokens: 3, totalTokens: 5 }`, and response headers map to `provider`, `providerName`, `model`, `apiKeyQueueMs`, and `providerQueueMs`. Add separate assertions for non-2xx JSON error, `AbortError` propagation, and a successful empty stream throwing `Empty stream`.

- [ ] **Step 2: Run the new check and verify it fails.**

Run:

```bash
node tests/basic-chat-stream.check.mjs
```

Expected: FAIL because `basicChatStream.js` does not exist.

- [ ] **Step 3: Implement the smallest transport helper.**

Export:

```js
export async function streamChatCompletion({
  model,
  messages,
  apiKey = "",
  signal,
  fetchImpl = globalThis.fetch,
  onText = () => {},
}) {}
```

The helper must POST `/api/dashboard/chat/completions` with `Content-Type: application/json`, `Accept: text/event-stream`, optional `Authorization: Bearer ${apiKey}`, body `{ model: model.requestModel || model.id, messages, stream: true }`, and `signal`. Parse `data:` lines with a carried buffer, ignore malformed JSON and `[DONE]`, use the existing response text shapes (`choices[0].delta.content`, `choices[0].message.content`, `output_text`, `text`), and flush the final buffer before returning. Throw a readable HTTP error from JSON fields `error.message`, `error`, `message`, or `Request failed (${status})`. Return `{ text, responseMeta }`, where `responseMeta.usage` uses `prompt_tokens`/`input_tokens`, `completion_tokens`/`output_tokens`, and `total_tokens`; `durationMs` is measured in the helper. Do not catch `AbortError`; callers need to distinguish cancellation.

- [ ] **Step 4: Run the helper check.**

Run:

```bash
node tests/basic-chat-stream.check.mjs
```

Expected: `basic-chat stream: ok`.

- [ ] **Step 5: Commit the isolated helper and check.**

```bash
git add 'src/app/(dashboard)/dashboard/basic-chat/basicChatStream.js' tests/basic-chat-stream.check.mjs
git commit -m "refactor: extract Basic Chat SSE streaming"
```

## Task 2: Add pure Compare selection and result helpers

**Files:**
- Create: `src/app/(dashboard)/dashboard/basic-chat/basicChatCompare.js`
- Test: `tests/basic-chat-compare.check.mjs`

- [ ] **Step 1: Write failing state checks.**

The test must import the helper and assert this API:

```js
const selected = addCompareModel([], modelA);
assert.deepEqual(addCompareModel(selected, modelA), [modelA]);
assert.equal(addCompareModel([modelA, modelB, modelC, modelD], modelE).length, 4);
assert.deepEqual(removeCompareModel([modelA, modelB], modelA.id), [modelB]);

const run = createCompareRun("hello", [], [modelA, modelB]);
assert.deepEqual(run.results.map((result) => result.status), ["pending", "pending"]);
const updated = updateCompareResult(run, modelA.id, { status: "done", text: "A" });
assert.equal(updated.results[0].text, "A");
assert.equal(updated.results[1].status, "pending");
assert.equal(resetCompareResult(updated, modelA.id).results[0].status, "pending");
assert.equal(markCompareStopped(updated, modelB.id).results[1].status, "stopped");
assert.equal("sessions" in createCompareRun("hello", [], [modelA]), false);
```

Also assert fewer than two models is rejected by `canStartCompare`, five models cannot be added, IDs remain unique, attachment arrays are copied, and result updates do not mutate the original run.

- [ ] **Step 2: Run the check and verify it fails.**

Run:

```bash
node tests/basic-chat-compare.check.mjs
```

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement pure helpers.**

Export:

```js
export const MAX_COMPARE_MODELS = 4;
export function addCompareModel(models, model) {}
export function removeCompareModel(models, modelId) {}
export function canStartCompare(models, draft, attachments) {}
export function createCompareRun(prompt, attachments, models) {}
export function updateCompareResult(run, modelId, patch) {}
export function resetCompareResult(run, modelId) {}
export function markCompareStopped(run, modelId) {}
```

`addCompareModel` must dedupe by `id` and refuse a fifth item. `canStartCompare` requires 2–4 models and either trimmed text or at least one attachment. `createCompareRun` stores a copied prompt/attachment array and creates `{ model, status: "pending", text: "", error: "", responseMeta: null }` per model, with no session field. All update functions return new objects and preserve other model cards.

- [ ] **Step 4: Run the state check.**

Run:

```bash
node tests/basic-chat-compare.check.mjs
```

Expected: `basic-chat compare state: ok`.

- [ ] **Step 5: Commit the pure state layer.**

```bash
git add 'src/app/(dashboard)/dashboard/basic-chat/basicChatCompare.js' tests/basic-chat-compare.check.mjs
git commit -m "feat: add ephemeral compare state helpers"
```

## Task 3: Integrate Compare state without changing normal Chat persistence

**Files:**
- Modify: `src/app/(dashboard)/dashboard/basic-chat/BasicChatPageClient.js`

- [ ] **Step 1: Add imports and Compare-only state.**

Import `streamChatCompletion` and the Compare helpers. Add state/ref values alongside existing state:

```js
const [mode, setMode] = useState("chat");
const [compareModels, setCompareModels] = useState([]);
const [compareRun, setCompareRun] = useState(null);
const [compareSending, setCompareSending] = useState(false);
const compareAbortControllersRef = useRef(new Map());
```

Do not add any Compare key to `STORAGE_KEYS`, the localStorage effect, `sessions`, or session constructors. Add a cleanup effect that aborts every controller and clears the map on unmount.

- [ ] **Step 2: Extract normal `runStream` onto the helper.**

Replace only the fetch/SSE body inside the existing normal `runStream` with `streamChatCompletion`. Preserve the current session message updates, title finalization, `isSending`, `streamingMessageId`, `streamingText`, and page error behavior. Map helper `onText` to the existing assistant message update. Map helper completion to `status: "done"`; map non-abort errors to the existing error message. Normal Chat must continue to use the same endpoint, request body, history, retry, and footer metadata.

- [ ] **Step 3: Add Compare lifecycle functions.**

Implement these callbacks inside `BasicChatPageClient`:

```js
const abortCompare = (modelId) => { /* abort only modelId */ };
const abortAllCompare = () => { /* abort every active controller */ };
const leaveCompare = () => { /* abort all, clear run and selection, set mode chat */ };
const toggleCompareModel = (model) => { /* add/remove, max four */ };
const startCompare = async () => { /* snapshot and launch one helper per model */ };
const retryCompareModel = async (modelId) => { /* reset one card and relaunch */ };
```

`startCompare` must refuse invalid selection, copy `draft` and `attachments`, resolve selected IDs against the current `modelIndex`, call `createCompareRun`, clear only the composer state, set `compareSending`, and launch one `streamChatCompletion` per model via `Promise.allSettled`. Each launch gets its own `AbortController`, updates only its card, and stores no session. On normal completion use `updateCompareResult(..., { status: "done", text, responseMeta })`; on `AbortError` use `markCompareStopped`; on all other errors use `{ status: "error", error: message }`. Delete each controller in `finally`; clear `compareSending` when all promises settle. A retry must reuse the current run's snapshotted prompt/attachments, not current draft or normal session messages, and only reset/relaunch one card.

- [ ] **Step 4: Run existing model restoration check.**

Run:

```bash
node tests/basic-chat-model-restore.check.mjs
```

Expected: `basic-chat custom model restore: ok`.

- [ ] **Step 5: Commit the lifecycle integration.**

```bash
git add 'src/app/(dashboard)/dashboard/basic-chat/BasicChatPageClient.js'
git commit -m "feat: run Basic Chat compare requests independently"
```

## Task 4: Add mode controls and accessible multi-model picker

**Files:**
- Modify: `src/app/(dashboard)/dashboard/basic-chat/BasicChatPageClient.js`

- [ ] **Step 1: Add the Chat/Compare mode control.**

In the existing header, render two buttons with `aria-pressed`, visible active styling, and labels `Chat` and `Compare`. Chat invokes `leaveCompare` only when leaving Compare; Compare sets mode to `compare` without changing sessions. Keep normal provider/model selectors and History visible only in Chat mode. Add a Compare `Stop all` control while Compare has active requests.

- [ ] **Step 2: Add the multi-model picker.**

In Compare mode, render the existing provider groups and model catalog as keyboard-operable checkbox-like buttons. Each option must expose `role="checkbox"`, `aria-checked`, provider and model name, and call `toggleCompareModel(model)`. Show selected models as removable chips with model-specific accessible labels. Disable or visibly reject the fifth selection. Keep the custom model input available under the active provider using the existing normalization logic.

- [ ] **Step 3: Wire composer controls.**

Use `canStartCompare(compareModels, draft, attachments)` for the send button. The composer label must say `Compare: N models`; the send button is disabled below two models, above four cannot occur, or with no text/images. Attachment handling remains the existing image-only flow. Enter sends Compare when in Compare mode and Chat otherwise. Disable model selection while a run is active only where changing it would invalidate the active run; do not cancel unrelated cards.

- [ ] **Step 4: Run lint/build syntax checks after UI integration.**

Run ESLint directly against the changed client files:

```bash
npx eslint 'src/app/(dashboard)/dashboard/basic-chat/BasicChatPageClient.js' \
  'src/app/(dashboard)/dashboard/basic-chat/basicChatStream.js' \
  'src/app/(dashboard)/dashboard/basic-chat/basicChatCompare.js'
```

Expected: exit code 0. Do not alter unrelated lint findings.

- [ ] **Step 5: Commit the UI integration.**

```bash
git add 'src/app/(dashboard)/dashboard/basic-chat/BasicChatPageClient.js'
git commit -m "feat: add Basic Chat compare mode controls"
```

## Task 5: Render independent result cards and metadata

**Files:**
- Modify: `src/app/(dashboard)/dashboard/basic-chat/BasicChatPageClient.js`

- [ ] **Step 1: Add the ephemeral prompt and result grid.**

When `mode === "compare"`, render the snapshotted prompt once, then one card per `compareRun.results`. Use a responsive two-column grid on wide screens and one column on narrow screens. Each card must show provider name, display model name, request model as secondary text, and text using `whitespace-pre-wrap`.

- [ ] **Step 2: Render statuses and per-card actions.**

Render visible labels `Waiting`, `Streaming`, `Done`, `Failed`, and `Stopped`. Streaming cards show a model-specific Stop button. Failed and stopped cards show Retry. Retry calls `retryCompareModel(result.model.id)` and does not affect other cards. Preserve partial text on stop/error.

- [ ] **Step 3: Render footer and response metadata safely.**

Use the existing `footerSettings` and `responseMeta` fields. Respect global footer visibility and custom message rules already used by normal Chat. Never render raw internal provider IDs as the primary footer text; use the existing footer text field behavior. Show usage, queue timing, duration, and detected footer only when configured/available. Use `aria-live="polite"` for card status, not for every token chunk.

- [ ] **Step 4: Run focused checks.**

Run:

```bash
node tests/basic-chat-stream.check.mjs
node tests/basic-chat-compare.check.mjs
node tests/basic-chat-model-restore.check.mjs
```

Expected: all three print their `...: ok` line and exit zero.

- [ ] **Step 5: Commit result rendering.**

```bash
git add 'src/app/(dashboard)/dashboard/basic-chat/BasicChatPageClient.js'
git commit -m "feat: render ephemeral Basic Chat compare results"
```

## Task 6: Build and automated regression validation

**Files:**
- Modify only files required to correct failures found by the checks.

- [ ] **Step 1: Run all focused Compare checks and the model check.**

```bash
node tests/basic-chat-stream.check.mjs && \
node tests/basic-chat-compare.check.mjs && \
node tests/basic-chat-model-restore.check.mjs
```

Expected: three success lines and exit code 0.

- [ ] **Step 2: Build the production artifact.**

```bash
npm run build
```

Expected: exit code 0 and the Basic Chat route included in the Next build. Fix only Compare-related errors, then rerun the focused checks.

- [ ] **Step 3: Check the working tree and commit any narrowly scoped fixes.**

```bash
git status --short
git diff --check
```

Expected: no whitespace errors; only Compare files and the committed plan/spec are changed. Commit fixes with:

```bash
git add 'src/app/(dashboard)/dashboard/basic-chat' tests/basic-chat-stream.check.mjs tests/basic-chat-compare.check.mjs
git commit -m "fix: harden Basic Chat compare validation"
```

## Task 7: Real authenticated acceptance path

**Files:**
- No planned source changes. Record observed behavior in the completion report.

- [ ] **Step 1: Start the isolated production-like app using the repository's established port procedure.**

Build first, start on an unused isolated port, and use the existing authenticated browser/session setup. Do not replace or restart production for this check.

- [ ] **Step 2: Verify normal Chat regression.**

Open the authenticated Basic Chat route, confirm Chat is the default, select one model, send one prompt, observe SSE completion, open History, reload, and confirm the normal conversation remains. Confirm footer settings still render as before.

- [ ] **Step 3: Verify two-model parallel Compare.**

Switch to Compare, select two working models from at least two connected providers when available, send one prompt, and observe two independent cards. Record each card's transition from Waiting/Streaming to Done or its own error. Confirm the prompt appears once and results are not listed in History.

- [ ] **Step 4: Verify failure isolation.**

Add/select one known-invalid custom model and one working model. Send the same prompt. Confirm the invalid card shows Failed while the working card can finish; no page-wide Chat error banner appears.

- [ ] **Step 5: Verify cancellation and retry isolation.**

Start a run with at least two active cards. Stop one card and confirm its partial text remains Stopped while another card continues. Retry the stopped/failed card and confirm only that card returns to Streaming and completes from the same snapshotted prompt.

- [ ] **Step 6: Verify ephemeral persistence and boundaries.**

Before and after Compare send/retry/stop/mode switch/reload, compare the authenticated History UI and `localStorage.getItem("basic-chat.sessions")`. Confirm Compare adds no session, does not alter the normal draft/session, and disappears on reload. Check 0/1/5 selection behavior, keyboard checkbox activation, mobile one-column layout, optional API-key path, global footer visibility, and Stop all.

- [ ] **Step 7: Verify graceful deployment.**

Deploy through the existing graceful production procedure. During deployment keep one active normal or Compare stream, confirm it drains without an abrupt connection failure, then verify `/login` and authenticated Basic Chat return successfully on the new process.

## Task 8: Final review and commit

- [ ] **Step 1: Review the diff against every approved requirement.**

```bash
git diff HEAD~6 -- 'src/app/(dashboard)/dashboard/basic-chat' tests/basic-chat-stream.check.mjs tests/basic-chat-compare.check.mjs
```

Check: 2–4 models, parallel SSE, independent errors, per-card stop/retry, no session/localStorage writes, normal Chat unchanged, responsive/accessibility states, footer metadata, and graceful unmount cleanup.

- [ ] **Step 2: Run final validation.**

```bash
git diff --check
node tests/basic-chat-stream.check.mjs
node tests/basic-chat-compare.check.mjs
node tests/basic-chat-model-restore.check.mjs
npm run build
```

Expected: all checks pass and build exits 0. Include real browser/API acceptance observations in the final report; do not substitute unit checks for that path.

- [ ] **Step 3: Commit only if final fixes remain.**

```bash
git status --short
git add 'src/app/(dashboard)/dashboard/basic-chat' tests/basic-chat-stream.check.mjs tests/basic-chat-compare.check.mjs
git commit -m "feat: complete Basic Chat parallel compare"
```

## Self-review

- **Spec coverage:** Goal/scope are covered by Tasks 3–5; client-side architecture and no backend fan-out by Tasks 1 and 3; data flow by Task 3; errors/cancellation by Tasks 1, 3, and 5; accessibility/responsive UI by Tasks 4–5; automated checks/build by Tasks 1, 2, and 6; real acceptance/deployment by Task 7; deliberate ephemeral limit by Tasks 2–3.
- **Placeholder scan:** No unresolved placeholders or unspecified implementation steps remain. Every command names exact files and expected outcomes.
- **Consistency:** Helper names, result statuses, state fields, endpoint, storage key, and model limits are consistent across all tasks.
