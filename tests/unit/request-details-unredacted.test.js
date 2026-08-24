import { describe, expect, it, vi } from "vitest";

const detail = {
  id: "request-1",
  provider: "openai-compatible-chat-node",
  model: "amanai/example",
  request: { messages: [{ role: "user", content: "secret prompt" }] },
  providerRequest: { input: [{ role: "user", content: "secret prompt" }] },
  providerResponse: { output: [{ content: "secret answer" }] },
  response: { content: "secret answer" },
};

vi.mock("@/lib/usageDb", () => ({
  getRequestDetails: vi.fn().mockResolvedValue({
    details: [detail],
    pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
  }),
}));

describe("request-details payload contract", () => {
  it("returns stored request and response payloads without redaction", async () => {
    const { GET } = await import("@/app/api/usage/request-details/route.js");
    const res = await GET(new Request("http://localhost/api/usage/request-details"));
    const body = await res.json();

    expect(body.details[0].request).toEqual(detail.request);
    expect(body.details[0].providerRequest).toEqual(detail.providerRequest);
    expect(body.details[0].providerResponse).toEqual(detail.providerResponse);
    expect(body.details[0].response).toEqual(detail.response);
  });
});
