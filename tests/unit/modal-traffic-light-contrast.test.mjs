import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Guard for WCAG 1.4.11 / 1.4.3 on the macOS-style traffic-light close dot.
// The dot is a solid #FF5F56 fill and the ✕ glyph only appears on hover, so a
// white glyph is the "obvious" choice but lands at 2.99:1 — below AA. The
// regression we lock down is the glyph colour, not the fill.
const modalSource = readFileSync(
  new URL("../../src/shared/components/Modal.js", import.meta.url),
  "utf8"
);

function channelToLinear(value8bit) {
  const c = value8bit / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex) {
  const raw = hex.replace("#", "");
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  return (
    0.2126 * channelToLinear(r) +
    0.7152 * channelToLinear(g) +
    0.0722 * channelToLinear(b)
  );
}

function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

test("modal close dot glyph clears WCAG AA against the red traffic light", () => {
  const dot = modalSource.match(
    /rounded-full bg-\[(#[0-9A-Fa-f]{6})\][^"]*group\/dot[\s\S]*?<span className="([^"]+)"/
  );

  assert.ok(dot, "traffic-light close dot markup with a glyph must exist");

  const [, dotFill, glyphClasses] = dot;
  const glyphColour = glyphClasses.match(/text-\[(#[0-9A-Fa-f]{6})\]/);

  assert.ok(
    glyphColour,
    `close glyph must use an explicit hex text colour (got: ${glyphClasses})`
  );
  assert.doesNotMatch(
    glyphClasses,
    /\btext-white\b/,
    "text-white on #FF5F56 is only 2.99:1 — use the dark glyph colour instead"
  );

  const ratio = contrastRatio(glyphColour[1], dotFill);
  assert.ok(
    ratio >= 4.5,
    `close glyph contrast ${ratio.toFixed(2)}:1 must be >= 4.5:1 (${glyphColour[1]} on ${dotFill})`
  );
});

test("modal close glyph keeps a non-colour affordance (aria-label)", () => {
  // WCAG 1.4.11 is moot if the control is unnameable; the icon-only button must
  // stay labelled regardless of the decorative colour change.
  assert.match(
    modalSource,
    /aria-label="Close"/,
    "icon-only close button must keep its aria-label"
  );
});
