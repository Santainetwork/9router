import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/app/(dashboard)/dashboard/basic-chat/BasicChatPageClient.js", import.meta.url), "utf8");
for (const expected of [
  'const [mode, setMode] = useState("chat")',
  "const compareAbortControllersRef = useRef(new Map())",
  "Promise.allSettled",
  "streamChatCompletion({",
  "canStartCompare(compareModels, draft, attachments)",
  'aria-pressed={mode === "compare"}',
  'role={mode === "compare" ? "checkbox" : undefined}',
  "buildUserContent({ content: prompt, attachments: runAttachments })",
  "responseMeta: response.responseMeta",
  "stopAllCompareRuns",
  "retryCompareModel",
]) assert.ok(source.includes(expected), `missing Compare integration: ${expected}`);
assert.ok(!/STORAGE_KEYS\s*=\s*\{[^}]*compare/s.test(source), "Compare state must not be persisted");
console.log("basic-chat-compare-integration: ok");
