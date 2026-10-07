// Structured docs integrity check: balanced fences, no stale anchors, and every
// cross-file link target exists. Ad-hoc check promoted to a runnable check.
import { readFileSync, existsSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const FILES = ["README.md", "SYSTEMD-MULTIWORKER.md"];
const REPO = process.cwd();

// GitHub's slugger (verified against a rendered README on github.com): lowercase,
// strip anything that is not word/space/hyphen, then replace each space with a
// dash. No trim: dropping punctuation first and NOT trimming afterwards is what
// leaves the leading dash in "🚀 Deployment & Maintenance" and the doubled dash
// in "SQLite + Redis multicore (Systemd)".
const headings = (text) =>
  [...text.matchAll(/^#{1,6}\s+(.*)$/gm)].map((m) =>
    m[1].toLowerCase().replace(/[^\w\s-]/g, "").replace(/ /g, "-"));

// Cross-file anchors: a link like [x](OTHER.md#anchor) must land on a real
// heading in that file. Nothing uses them today; this is the guard.
test("cross-file anchor links resolve", () => {
  for (const file of FILES) {
    const text = readFileSync(`${REPO}/${file}`, "utf8");
    for (const [, target, anchor] of text.matchAll(/\]\(([^)#]+)#([^)]+)\)/g)) {
      if (target.startsWith("http")) continue;
      assert.ok(existsSync(`${REPO}/${target}`), `${file} links to missing file ${target}`);
      const heads = headings(readFileSync(`${REPO}/${target}`, "utf8"));
      assert.ok(heads.includes(anchor), `${file} links to ${target}#${anchor}, which does not exist`);
    }
  }
});

// A broken in-page anchor is silently invisible to a test that only parses the
// clean copy, so assert the checker behaves exactly like GitHub on the shapes
// that once broke: a leading emoji or a "+" between words must both survive
// into the slug. The earlier version of this check asserted the opposite of
// GitHub's rule and made the README's seven wrong anchors look correct.
test("the anchor checker reproduces GitHub's slug shape", () => {
  assert.deepEqual(headings("## 🚀 Deployment & Maintenance"), ["-deployment--maintenance"]);
  assert.deepEqual(headings("#### SQLite + Redis multicore (Systemd)"), ["sqlite--redis-multicore-systemd"]);
  assert.deepEqual(headings("## Plain Heading"), ["plain-heading"]);
  const body = "## Real Heading\n\n[go](#real-heading)";
  assert.ok(headings(body).includes("real-heading"), "checker must resolve the plain form");
});

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
