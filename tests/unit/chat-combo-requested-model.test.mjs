import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("src/sse/handlers/chat.js does not reference an undefined requestedModel variable in credential selection", () => {
  const source = fs.readFileSync(new URL("../../src/sse/handlers/chat.js", import.meta.url), "utf8");
  
  // Extract handleSingleModelChat function body
  const fnMatch = source.match(/async function handleSingleModelChat\([\s\S]*?\n\}/);
  assert.ok(fnMatch, "handleSingleModelChat function found");
  const fnBody = fnMatch[0];

  // If requestedModel is passed to getProviderCredentials, it must be declared in handleSingleModelChat scope
  const credsCall = fnBody.match(/getProviderCredentials\([^)]*requestedModel[^)]*\)/);
  if (credsCall) {
    // Check that requestedModel is declared (const/let/param)
    const hasDecl = /const\s+requestedModel\b|let\s+requestedModel\b|var\s+requestedModel\b|\bhandleSingleModelChat\([^)]*\brequestedModel\b/.test(fnBody);
    assert.ok(hasDecl, "requestedModel must be declared in handleSingleModelChat scope before being passed to getProviderCredentials");
  }
});
