import test from "node:test";
import assert from "node:assert/strict";
import {
  stripFooterFromText,
  stripFootersFromMessages,
  hasFooterSignature,
  appendFooterToOpenAIBody,
  wrapOpenAIStreamWithFooter,
} from "../../open-sse/handlers/chatCore/responseFooter.js";

test("stripFooterFromText removes SantaiNetwork footer cleanly", () => {
  const textWithFooter = "Here is the code.\n\n---\nby SantaiNetwork · gemini-3.8-flash · 6.9s · 804791 Token Total";
  const stripped = stripFooterFromText(textWithFooter);
  assert.equal(stripped, "Here is the code.");
  assert.equal(hasFooterSignature(stripped), false);
});

test("stripFootersFromMessages strips prior footers from assistant turns in conversation", () => {
  const messages = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "Halo!\n\n---\nby SantaiNetwork · gemini-3.8-flash · 6.9s · 804791 Token Total" },
    { role: "user", content: "lanjutkan" },
  ];
  const cleaned = stripFootersFromMessages(messages);
  assert.equal(cleaned[1].content, "Halo!");
  assert.equal(hasFooterSignature(cleaned[1].content), false);
});

test("appendFooterToOpenAIBody does not duplicate if message already has footer", () => {
  const body = {
    choices: [{
      message: { content: "answer\n\n---\nby SantaiNetwork · gemini-3.8-flash · 6.9s · 804791 Token Total" }
    }]
  };
  appendFooterToOpenAIBody(body, "\n\n---\nby SantaiNetwork · gemini-3.8-flash · 2.6s · 33823 Token Total");
  assert.equal((body.choices[0].message.content.match(/by SantaiNetwork/g) || []).length, 1);
});

test("wrapOpenAIStreamWithFooter does not duplicate footer if stream text already carries signature", async () => {
  const input = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        'data: {"choices":[{"delta":{"content":"done\\n\\n---\\nby SantaiNetwork · gemini-3.8-flash · 6.9s · 804791 Token Total"},"finish_reason":null}]}\n\n'
        + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
        + "data: [DONE]\n\n"
      ));
      controller.close();
    },
  });

  const output = await new Response(
    wrapOpenAIStreamWithFooter(input, "\n\n---\nby SantaiNetwork · gemini-3.8-flash · 2.6s · 33823 Token Total")
  ).text();

  assert.equal((output.match(/by SantaiNetwork/g) || []).length, 1);
});
