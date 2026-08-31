import Database from "better-sqlite3";

const dbPath = "/var/lib/9router/.9router/db/data.sqlite";
const db = new Database(dbPath, { readonly: true });

console.log("=== PRODUCTION requestDetails — collision analysis ===\n");

const rows = db
  .prepare("SELECT id, timestamp, provider, model, status FROM requestDetails ORDER BY timestamp DESC LIMIT 40")
  .all();

console.log(`Recent rows: ${rows.length}\n`);

// Group by the id PREFIX (timestamp-counter) to detect ON CONFLICT overwrites.
// Two DIFFERENT logical requests sharing an id-prefix means one overwrote the other.
const byId = new Map();
let newFmt = 0, oldFmt = 0;
for (const r of rows) {
  const isNew = !r.id.includes("T") && !r.id.includes("Z");
  isNew ? newFmt++ : oldFmt++;
  if (!byId.has(r.id)) byId.set(r.id, []);
  byId.get(r.id).push(r);
}

console.log(`new-format ids: ${newFmt}, old-format ids: ${oldFmt}`);

// Check for duplicate full ids within this sample (should be impossible due to PK)
let dupFull = 0;
for (const [id, list] of byId) {
  if (list.length > 1) { dupFull++; console.log(`DUPLICATE full id in sample: ${id} x${list.length}`); }
}

// Detect counter pattern: do new-format ids have an 8-char base36 counter segment?
console.log("\nSample of newest new-format ids:");
rows.filter(r => !r.id.includes("T")).slice(0, 12).forEach(r => {
  console.log(`  ${r.id}   [${r.provider}/${r.model}] ${r.status}`);
});

// Now the REAL question: are recent rows being overwritten?
// Check timestamps: if many rows share the exact same timestamp + model, they may be the same logical request saved twice.
console.log("\nRows sharing same (timestamp, provider, model):");
const seen = new Map();
for (const r of rows) {
  const k = `${r.timestamp}|${r.provider}|${r.model}`;
  seen.set(k, (seen.get(k) || 0) + 1);
}
for (const [k, c] of seen) if (c > 1) console.log(`  ${k}  x${c}`);

console.log("\nTotal rows in table:", db.prepare("SELECT COUNT(*) c FROM requestDetails").get().c);
db.close();
