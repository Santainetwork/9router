// Task 6: shared dbVersion mutation helper. Bump inside the same SQLite
// transaction as the correctness mutation; publish-after-commit is the writer's
// separate wake-up hint. Never bump outside a transaction.
export function bumpDbVersion(db, at = new Date().toISOString()) {
  const cur = db.get("SELECT version FROM dbVersion WHERE id = 1");
  const next = (cur ? Number(cur.version) : 0) + 1;
  db.run(
    "INSERT INTO dbVersion(id, version, updatedAt) VALUES(1, ?, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version, updatedAt = excluded.updatedAt",
    [String(next), at],
  );
  return next;
}
