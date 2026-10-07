import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));
const read = (path) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");

// Semantic-token utilities only. Literal Tailwind palette classes bake a fixed
// hex at build time and ignore the scoped friend-light/friend-dark overrides,
// which is the whole point of the token migration.
const TOKEN_UTIL = "(?:bg|text|border|ring|divide|outline|decoration|from|to|via)-(?:danger|success|warning|info)";
const LITERAL_UTIL = "(?:bg|text|border|ring|divide|outline|decoration|from|to|via)-(?:red|rose|green|emerald|amber|yellow|orange|blue|sky|indigo|violet|purple|cyan|teal)-\\d+";

// Brand palettes live outside the variant shell by design: they are not part of
// the dashboard token surface, so they keep literal color classes.
const OUT_OF_SCOPE = ["app/landing", "app/usage-check"];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules") continue;
      walk(full, out);
    } else if (/\.(js|jsx)$/.test(entry)) {
      out.push(full.slice(SRC.length + 1));
    }
  }
  return out;
}

const SHELL_FILES = walk(SRC).filter(
  (rel) => !OUT_OF_SCOPE.some((dir) => rel.startsWith(dir))
);

test("no literal Tailwind palette utilities in the variant shell", () => {
  const survivors = [];
  const literal = new RegExp(`\\b${LITERAL_UTIL}`, "g");
  for (const rel of SHELL_FILES) {
    const src = readFileSync(join(SRC, rel), "utf8");
    for (const cls of src.match(literal) ?? []) {
      survivors.push(`${rel}: ${cls}`);
    }
  }
  assert.deepEqual(survivors, [], `literal palette classes must be tokens:\n${survivors.join("\n")}`);
});

test("no malformed token utilities (double modifier, numeric shade, dangling slash)", () => {
  const malformed = [];
  // bg-info/20/[0.04] is what the codemod emitted when the original class had
  // an arbitrary value. Tailwind drops the whole rule, silently.
  const DOUBLE_MOD = /\b(?:bg|text|border|ring|from|via|to)-[a-z-]+\/\d+\/\[/;
  // A semantic token has no numeric shade of its own: bg-danger-500 is invalid.
  const NUMERIC_SHADE = new RegExp(`\\b${TOKEN_UTIL}-\\d`);
  const DANGLING = /\b(?:bg|text|border|ring)-(?:danger|success|warning|info)\/(?!\d+|\[)/;

  for (const rel of SHELL_FILES) {
    const src = readFileSync(join(SRC, rel), "utf8");
    for (const m of src.match(DOUBLE_MOD) ?? []) malformed.push(`${rel}: ${m}`);
    for (const m of src.match(NUMERIC_SHADE) ?? []) malformed.push(`${rel}: ${m}`);
    for (const m of src.match(DANGLING) ?? []) malformed.push(`${rel}: ${m}`);
  }
  assert.deepEqual(malformed, [], `malformed token utilities:\n${malformed.join("\n")}`);
});

test("every semantic-token utility token is defined in globals.css", () => {
  const css = read("app/globals.css");
  const used = new Set();
  const re = new RegExp(`\\b(?:bg|text|border|ring|divide|from|to|via)-(danger|success|warning|info)\\b`, "g");
  for (const rel of SHELL_FILES) {
    const src = readFileSync(join(SRC, rel), "utf8");
    for (const m of src.matchAll(re)) used.add(m[1]);
  }
  const undefined = [...used].filter((t) => !css.includes(`--color-${t}:`));
  assert.deepEqual(undefined, [], `missing --color-* definitions: ${undefined.join(", ")}`);
});

test("friend variant blocks override status tokens in both modes", () => {
  const css = read("app/globals.css");
  const light = css.slice(css.indexOf('html[data-ui-variant="friend"] {'), css.indexOf("html.dark[data-ui-variant=\"friend\"] {"));
  const dark = css.slice(css.indexOf('html.dark[data-ui-variant="friend"] {'));
  assert.ok(light.length > 0, "friend light block present");
  assert.ok(dark.length > 0, "friend dark block present");
  for (const token of ["danger", "success", "warning", "info"]) {
    const lightValue = new RegExp(`--color-${token}:\\s*(#[0-9a-f]{6})`).exec(light);
    const darkValue = new RegExp(`--color-${token}:\\s*(#[0-9a-f]{6})`).exec(dark);
    assert.ok(lightValue, `friend light defines --color-${token}`);
    assert.ok(darkValue, `friend dark defines --color-${token}`);
    assert.notEqual(
      lightValue[1],
      darkValue[1],
      `--color-${token} must differ between friend light and dark or variant switching is a no-op`
    );
  }
});

test("avatar palette pairs every tint with a readable foreground", () => {
  // Avatar used one shared `text-white` while entries were literal shades. With
  // tokens each entry must carry its own foreground or some initials turn
  // low-contrast.
  const avatar = read("shared/components/Avatar.js");
  const entries = [...avatar.matchAll(/"(bg-(?:danger|warning|success|info|primary|surface)[^"]*)"/g)].map((m) => m[1]);
  assert.ok(entries.length >= 5, `expected several palette entries, got ${entries.length}`);
  const missingFg = entries.filter((e) => !/text-(?:danger|warning|success|info|primary|text-main|white)\b/.test(e));
  assert.deepEqual(missingFg, [], `palette entries without a foreground: ${missingFg.join(", ")}`);
  // The old 17-shade literal palette is gone.
  assert.doesNotMatch(avatar, /bg-(?:lime|fuchsia|rose)-(?:600|700)/);
});

test("donate pill keeps its brand accent in both headers", () => {
  for (const rel of ["shared/components/Header.js", "shared/components/HeaderAlt.js"]) {
    const header = read(rel);
    assert.match(
      header,
      /bg-pink-500\/10 text-pink-800 dark:text-pink-300/,
      `${rel}: donate pill must keep the AA-verified pink accent`
    );
  }
});
