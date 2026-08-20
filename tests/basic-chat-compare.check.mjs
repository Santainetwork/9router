import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/app/(dashboard)/dashboard/basic-chat/basicChatCompare.js", import.meta.url), "utf8");
const module = await import(`data:text/javascript,${encodeURIComponent(source)}`);

const {
  MAX_COMPARE_MODELS,
  addCompareModel,
  removeCompareModel,
  canStartCompare,
  createCompareRun,
  updateCompareResult,
  resetCompareResult,
  markCompareStopped,
} = module;

// Test 1: MAX_COMPARE_MODELS is 4
assert.equal(MAX_COMPARE_MODELS, 4, "MAX_COMPARE_MODELS should be 4");

// Test 2: addCompareModel adds models up to max
const baseModels = [];
let added = addCompareModel(baseModels, { id: "m1", name: "Model 1" });
assert.deepEqual(added, [{ id: "m1", name: "Model 1" }]);

added = addCompareModel(added, { id: "m2", name: "Model 2" });
assert.deepEqual(added, [
  { id: "m1", name: "Model 1" },
  { id: "m2", name: "Model 2" }
]);

// Test 3: addCompareModel dedupes by id
const duped = addCompareModel(added, { id: "m1", name: "Model 1" });
assert.deepEqual(duped, added, "addCompareModel should not duplicate same id");

// Test 4: addCompareModel allows up to 4, refuses fifth
const threeModels = addCompareModel(added, { id: "m3", name: "Model 3" });
assert.equal(threeModels.length, 3, "should have 3 after adding m3");
const fourModels = addCompareModel(threeModels, { id: "m4", name: "Model 4" });
assert.equal(fourModels.length, 4, "4th model should be allowed");
const refused = addCompareModel(fourModels, { id: "m5", name: "Model 5" });
assert.equal(refused.length, 4, "fifth model should be refused");
assert.equal(refused.find(m => m.id === "m5"), undefined, "m5 should not appear");

const fourth = fourModels;
const fifth = refused;

// Test 5: removeCompareModel removes by id
const removed = removeCompareModel(fourModels, "m2");
assert.equal(removed.length, 3, "should have 3 models after removal");
assert.equal(removed.find(m => m.id === "m2"), undefined, "m2 should be removed");
assert.equal(removed.filter(m => m.id !== "m2").length, 3, "other models preserved");

// Test 6: canStartCompare requires 2-4 models AND (trimmed text OR attachment)
assert.equal(canStartCompare([], "", []), false, "0 models should fail");
assert.equal(canStartCompare([fourth[0]], "", []), false, "1 model should fail");
assert.equal(canStartCompare([fourth[0], fourth[1]], "", []), false, "2 models + no content should fail");
assert.equal(canStartCompare([fourth[0], fourth[1]], "hello", []), true, "2 models + text should pass");
assert.equal(canStartCompare([fourth[0], fourth[1]], "", [{ type: "image", url: "data:" }]), true, "2 models + attachment should pass");
assert.equal(canStartCompare(fifth, "hello", []), true, "4 models + text should pass");

// Test 7: createCompareRun creates results array with correct structure
const testRun = createCompareRun("test prompt", [{ type: "image", url: "data:image/png;base64,ABC" }], fifth);
assert.equal(testRun.prompt, "test prompt", "prompt should be copied");
assert.deepEqual(testRun.attachments, [{ type: "image", url: "data:image/png;base64,ABC" }], "attachments should be copied");
assert.equal(Array.isArray(testRun.results), true, "results should be array");
assert.equal(testRun.results.length, 4, "should have 4 results for 4 models");

for (const result of testRun.results) {
  assert.equal(result.status, "pending", "initial status should be pending");
  assert.equal(result.text, "", "initial text should be empty");
  assert.equal(result.error, null, "initial error should be null");
  assert.equal(result.responseMeta, null, "initial responseMeta should be null");
  assert.notEqual(result.modelId, undefined, "modelId should exist");
  assert.equal(Object.hasOwn(result, "sessions"), false, "should NOT have sessions field");
}

// Test 8: No session field at all
assert.ok(!(testRun instanceof Object && "sessions" in testRun), "run should not have sessions field");
const hasSessionsField = Object.keys(testRun).includes("sessions");
assert.equal(hasSessionsField, false, "createCompareRun should not include sessions");

// Test 9: updateCompareResult is immutable, updates target only
const updated = updateCompareResult(testRun, testRun.results[0].modelId, { status: "done", text: "Hello world" });
assert.equal(updated.results[0].text, "Hello world", "target result should be updated");
assert.equal(updated.results[1].status, "pending", "other results should remain unchanged");
assert.equal(updated.results[0].status, "done", "target status should change");
assert.equal(updated.results[0].text, "Hello world", "target text should change");
assert.deepStrictEqual(updated.results[0].error, null, "target error untouched");
assert.deepStrictEqual(updated.results[0].responseMeta, null, "target responseMeta untouched");

// Test 10: updateCompareResult doesn't mutate original
assert.equal(testRun.results[0].text, "", "original run should NOT be mutated");
assert.equal(testRun.results[0].status, "pending", "original status unchanged");

// Test 11: resetCompareResult clears text/error/meta, keeps status pending
const runWithError = { ...testRun };
runWithError.results[0] = {
  ...runWithError.results[0],
  status: "failed",
  text: "some error occurred",
  error: "network error",
  responseMeta: { usage: { total_tokens: 10 } }
};
const resetRun = resetCompareResult(runWithError, runWithError.results[0].modelId);
assert.equal(resetRun.results[0].status, "pending", "reset should set status pending");
assert.equal(resetRun.results[0].text, "", "reset should clear text");
assert.equal(resetRun.results[0].error, null, "reset should clear error");
assert.equal(resetRun.results[0].responseMeta, null, "reset should clear responseMeta");
assert.equal(runWithError.results[0].status, "failed", "original should not mutate");

// Test 12: markCompareStopped preserves text sets stopped
const withText = { ...testRun };
withText.results[0] = {
  ...withText.results[0],
  status: "streaming",
  text: "Some partial content here"
};
const stopped = markCompareStopped(withText, withText.results[0].modelId);
assert.equal(stopped.results[0].status, "stopped", "status should become stopped");
assert.equal(stopped.results[0].text, "Some partial content here", "text should be preserved");
assert.equal(stopped.results[1].status, "pending", "other cards untouched");

console.log("basic-chat compare state: ok");
