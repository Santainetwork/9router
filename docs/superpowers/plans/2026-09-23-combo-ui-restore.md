# Combo Searchable Grid Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the pre-v0.5.85 searchable combo-card grid while retaining v0.5.85 capability aggregation, model migration, Fusion, selection, and bulk operations.

**Architecture:** Keep all API and state behavior in the existing combo page. Change only list selection/rendering and `ComboCard` presentation. Add a source regression test because the defect is a render-source mismatch inside a client component.

**Tech Stack:** Next.js App Router, React, Tailwind CSS, Node.js built-in test runner.

---

## File structure

- Create `tests/unit/combo-page-search-ui.test.mjs`: guard filtered rendering, visible select-all, legacy grid, capability aggregation, and legacy-model migration.
- Modify `src/app/(dashboard)/dashboard/combos/page.js`: render filtered grid, scope select-all to visible items, restore old card presentation while preserving current capability logic and bulk selection.

### Task 1: Add failing regression checks

**Files:**
- Create: `tests/unit/combo-page-search-ui.test.mjs`
- Test: `tests/unit/combo-page-search-ui.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../../src/app/(dashboard)/dashboard/combos/page.js", import.meta.url),
  "utf8"
);

test("combo page renders the filtered result in the searchable card grid", () => {
  assert.match(source, /grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4/);
  assert.match(source, /return filteredCombos\.map\(\(combo\) =>/);
  assert.doesNotMatch(source, /return combos\.map\(\(combo\) =>/);
});

test("select all is scoped to visible filtered combos", () => {
  assert.match(source, /filteredCombos\.map\(\(combo\) => combo\.id\)/);
});

test("v0.5.85 combo compatibility remains enabled", () => {
  assert.match(source, /aggregateComboCapabilities/);
  assert.match(source, /upgradeLegacyModel/);
  assert.match(source, /mimo-v2\.6-flash-free/);
});
```

- [ ] **Step 2: Run test and verify RED**

Run:

```bash
node --test tests/unit/combo-page-search-ui.test.mjs
```

Expected: first two tests fail because HEAD uses a vertical list, `combos.map`, and select-all from all combos. Compatibility test passes.

- [ ] **Step 3: Commit the RED test**

```bash
git add tests/unit/combo-page-search-ui.test.mjs
git commit -m "test(combos): require searchable legacy grid"
```

### Task 2: Restore filtered selection semantics

**Files:**
- Modify: `src/app/(dashboard)/dashboard/combos/page.js:204-217`
- Test: `tests/unit/combo-page-search-ui.test.mjs`

- [ ] **Step 1: Replace selection derivation**

Use visible IDs for `allSelected` and `toggleSelectAll`:

```js
const visibleIds = filteredCombos.map((combo) => combo.id);
const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));
const someSelected = selectedIds.length > 0;

const toggleSelectAll = () => {
  setSelectedIds((prev) => {
    if (allSelected) return prev.filter((id) => !visibleIds.includes(id));
    return [...new Set([...prev, ...visibleIds])];
  });
};
```

Keep `selectedCombos` based on the full `combos` array so explicitly selected hidden items remain valid until cleared.

- [ ] **Step 2: Run regression test**

```bash
node --test tests/unit/combo-page-search-ui.test.mjs
```

Expected: select-all test passes; grid/render test remains RED.

### Task 3: Restore legacy grid and card presentation

**Files:**
- Modify: `src/app/(dashboard)/dashboard/combos/page.js:717-800`
- Modify: `src/app/(dashboard)/dashboard/combos/page.js:881-1017`
- Test: `tests/unit/combo-page-search-ui.test.mjs`

- [ ] **Step 1: Keep the selection toolbar, replace only its list container**

After the existing selection toolbar, render:

```jsx
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
  {(() => {
    const comboByName = Object.fromEntries(combos.map((c) => [c.name, c.models]));
    return filteredCombos.map((combo) => (
      <ComboCard
        key={combo.id}
        combo={combo}
        getCaps={getCaps}
        comboByName={comboByName}
        activeProviders={activeProviders}
        copied={copied}
        onCopy={copy}
        onEdit={() => setEditingCombo(combo)}
        onDelete={() => handleDelete(combo.id)}
        strategy={comboStrategies[combo.name] || {}}
        onSetStrategy={(patch) => handleSetComboStrategy(combo.name, patch)}
        selected={selectedIds.includes(combo.id)}
        onToggleSelect={() => toggleSelect(combo.id)}
      />
    ));
  })()}
</div>
```

- [ ] **Step 2: Restore the old card shell**

Use the card structure from `24f09436:src/app/(dashboard)/dashboard/combos/page.js`: rounded grid card, name/copy header, strategy badge, numbered model rows, four-row collapse threshold, Fusion judge panel, strategy footer, edit/delete buttons.

Preserve these current additions inside that shell:

```js
const [expanded, setExpanded] = useState(false);
const comboCaps = aggregateComboCapabilities(combo.models, comboByName);
```

Add the checkbox beside the header icon:

```jsx
<input
  type="checkbox"
  checked={selected}
  onChange={onToggleSelect}
  onClick={(event) => event.stopPropagation()}
  aria-label={`Select ${combo.name}`}
  className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
/>
```

Resolve nested combo badges without changing API behavior:

```jsx
<CapacityBadges
  caps={
    comboByName[model]
      ? aggregateComboCapabilities(comboByName[model], comboByName)
      : getCaps?.(model)
  }
  size={14}
/>
```

Display aggregate context/output beneath the model count when available:

```jsx
{comboCaps && (
  <span className="text-[10px] text-text-muted">
    ctx {fmtK(comboCaps.contextWindow)} · max {fmtK(comboCaps.maxOutput)}
  </span>
)}
```

- [ ] **Step 3: Run focused tests and verify GREEN**

```bash
node --test tests/unit/combo-page-search-ui.test.mjs tests/unit/combo-capabilities.test.js tests/unit/combo-presets.test.js
```

Expected: all tests pass.

- [ ] **Step 4: Commit implementation**

```bash
git add 'src/app/(dashboard)/dashboard/combos/page.js'
git commit -m "fix(combos): restore searchable card grid"
```

### Task 4: Verify and review

**Files:**
- Verify: `src/app/(dashboard)/dashboard/combos/page.js`
- Verify: `tests/unit/combo-page-search-ui.test.mjs`

- [ ] **Step 1: Run full project verification**

```bash
npm run verify
npm run build
git diff --check HEAD~2..HEAD
git status --short --branch
```

Expected: provider/OAuth baselines pass; Node suite has no failures; production build exits 0; diff check emits nothing; worktree is clean.

- [ ] **Step 2: Inspect final source invariants**

```bash
grep -nE 'filteredCombos\.map|return combos\.map|grid-cols-1 md:grid-cols-2|upgradeLegacyModel|aggregateComboCapabilities' \
  'src/app/(dashboard)/dashboard/combos/page.js'
```

Expected: filtered map, grid, migration, and capability aggregation present; no `return combos.map((combo)`.

- [ ] **Step 3: Independent review**

Review only the two implementation commits for functional regressions, selection edge cases, accessibility, and accidental removal of v0.5.85 behavior. Resolve findings before completion.

- [ ] **Step 4: Confirm operational boundary**

Do not run installer, copy release artifacts, restart services, push, or deploy. Report source-only completion and exact verification results.
