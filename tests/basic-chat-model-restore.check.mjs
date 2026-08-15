import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/app/(dashboard)/dashboard/basic-chat/basicChatModels.js", import.meta.url), "utf8");
const { restoreSessionModel } = await import(`data:text/javascript,${encodeURIComponent(source)}`);

const catalogModel = { id: "myr/qd/auto", requestModel: "myr/qd/auto", name: "Auto" };
const modelIndex = new Map([[catalogModel.id, catalogModel]]);
const fallback = { id: "myr/qd/fallback" };

assert.equal(restoreSessionModel({ modelId: catalogModel.id }, modelIndex, fallback), catalogModel);
assert.deepEqual(restoreSessionModel({
  modelId: "myr/custom/new-model",
  modelName: "new-model",
  providerId: "provider-uuid",
  providerName: "Moyra",
}, modelIndex, fallback), {
  id: "myr/custom/new-model",
  requestModel: "myr/custom/new-model",
  name: "new-model",
  providerId: "provider-uuid",
  providerName: "Moyra",
  source: "custom",
});
assert.equal(restoreSessionModel({}, modelIndex, fallback), fallback);

console.log("basic-chat custom model restore: ok");
