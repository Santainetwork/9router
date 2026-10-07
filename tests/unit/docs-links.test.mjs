// Structured docs integrity check: balanced fences, no stale anchors, and every
// cross-file link target exists. Ad-hoc check promoted to a runnable check.
import { readFileSync, existsSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const FILES = ["README.md", "SYSTEMD-MULTIWORKER.md"];
const REPO = process.cwd();

// GitHub's slugger: lowercase, delete anything that is not word/space/hyphen
// (an emoji or "&" leaves an empty word behind), then spaces become hyphens.
// So "🚀 Deployment & Maintenance" slugs to "-deployment--maintenance".
const headings = (text) =>
  [...text.matchAll(/^#{1,6}\s+(.*)$/gm)].map((m) =>
    m[1].toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-"));

for (const file of FILES) {
  const text = readFileSync(`${REPO}/${file}`, "utf8");
  test(`${file}: fences balanced`, () => {
    const n = (text.match(/^```/gm) || []).length;
    assert.equal(n % 2, 0, `${file} has ${n} fence markers`);
  });
  test(`${file}: every in-page anchor resolves`, () => {
    const anchors = headings(text);
    for (const [, target] of text.matchAll(/\]\(#([^)]+)\)/g)) {
      assert.ok(anchors.includes(target), `${file} links to missing anchor #${target}`);
    }
  });
  test(`${file}: every relative file link exists`, () => {
    for (const [, target] of text.matchAll(/\]\((?!https?:|#|mailto:)([^)]+)\)/g)) {
      const path = target.split("#")[0];
      if (!path) continue;
      assert.ok(existsSync(`${REPO}/${path}`), `${file} links to missing file ${path}`);
    }
  });
}
