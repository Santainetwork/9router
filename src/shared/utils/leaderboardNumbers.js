const AGGREGATE_FIELDS = [
  "total_requests",
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "total_cost",
];

export function normalizeLeaderboardNumbers(row) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      AGGREGATE_FIELDS.includes(key) ? (Number.isFinite(Number(value)) ? Number(value) : 0) : value,
    ])
  );
}
