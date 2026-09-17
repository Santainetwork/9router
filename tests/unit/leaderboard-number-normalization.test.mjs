import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLeaderboardNumbers } from "../../src/shared/utils/leaderboardNumbers.js";

test("leaderboard aggregate strings become finite numbers", () => {
  assert.deepEqual(
    normalizeLeaderboardNumbers({
      total_requests: "12",
      input_tokens: "345",
      output_tokens: "67",
      total_tokens: "412",
      total_cost: "1.25",
    }),
    {
      total_requests: 12,
      input_tokens: 345,
      output_tokens: 67,
      total_tokens: 412,
      total_cost: 1.25,
    }
  );
});

test("invalid leaderboard aggregates become zero", () => {
  assert.deepEqual(
    normalizeLeaderboardNumbers({ total_requests: null, total_tokens: "not-a-number" }),
    { total_requests: 0, total_tokens: 0 }
  );
});
