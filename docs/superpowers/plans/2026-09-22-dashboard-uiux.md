# Dashboard UI/UX Implementation Plan

**Goal:** Deliver the selected Refined Operations Console without changing backend behavior.
**Architecture:** Incremental changes to existing shared primitives and dashboard components.
Three file-disjoint workers implement independently, coordinator integrates and owns tables.
**Tech Stack:** Next.js, React 19, Tailwind 4, existing Node tests, real browser acceptance.

## Task 1: Rendering and editor, DeepSeek

Ownership: `src/shared/components/UsageStats.js`,
`src/app/(dashboard)/dashboard/usage/components/UsageTable.js`,
`src/app/(dashboard)/dashboard/console-log/ConsoleLogClient.js`,
`src/app/(dashboard)/dashboard/translator/page.js`, and a focused regression test.

- [ ] Reproduce avoidable render/sort work with an executable focused check.
- [ ] Stabilize derived data and expensive child boundaries, keep stream semantics.
- [ ] Preserve dynamic Monaco import, reserve editor loading dimensions.
- [ ] Run focused tests and record exact results, coordinator reviews diff.

## Task 2: Visual system, Kimi K3

Ownership: `src/app/globals.css`, `src/shared/components/Card.js`,
`src/shared/components/Badge.js`,
`src/app/(dashboard)/dashboard/DashboardOverviewClient.js`, focused visual tests.

- [ ] Test semantic color pairs and missing utility token definitions first.
- [ ] Refine hierarchy, readable palette, focus and reduced motion.
- [ ] Display honest active/fallback/error/unknown states from existing data.
- [ ] Preserve upstream names and improve loading/error/empty presentation.

## Task 3: Navigation and loading, GPT-5.6-sol

Ownership: `src/shared/components/layouts/DashboardLayout.js`,
`src/shared/components/Sidebar.js`, `src/shared/components/Header.js`,
`src/shared/components/Tooltip.js`, `src/shared/components/Loading.js`,
`src/app/(dashboard)/dashboard/loading.js`, focused navigation tests.

- [ ] Test active-route metadata and accessible navigation contracts first.
- [ ] Add compact mode and mobile focus management with no hidden tabbable links.
- [ ] Add skip target, clear breadcrumbs, labelled controls, responsive shell.
- [ ] Supply reusable table/card skeletons, no new state store.

## Task 4: Table ergonomics, coordinator

Ownership: `src/app/(dashboard)/dashboard/usage/components/RequestDetailsTab.js`,
`src/app/(dashboard)/dashboard/providers/components/ModelsCard.js`,
`src/app/(dashboard)/dashboard/providers/components/ConnectionsCard.js`,
`src/app/(dashboard)/dashboard/providers/page.js`, focused table tests.

- [ ] Reproduce missing sticky/keyboard/long-content/loading handling.
- [ ] Bound table scroll, responsive filter controls and labelled model search.
- [ ] Keep mutation handlers and API contracts unchanged.

## Task 5: Whole-result acceptance

- [ ] `npm run verify`: all tests pass, skips stated explicitly.
- [ ] `npm run build` with isolated data directory: exit zero, standalone assets copied.
- [ ] Real local Next app: 375/768/1440/2560px, dark/light, no document overflow.
- [ ] Sidebar: compact tooltip, active route, mobile Escape/focus return, skip link.
- [ ] Request details/providers/model list: filters, long content, sticky header,
  keyboard-reachable actions, loading/empty/error states.
- [ ] Editor: chunk deferred, loading geometry, translate interaction retained.
- [ ] Realtime: existing transport cleanup retained, metrics/log updates still render.
- [ ] Verify backend/Go/config diff empty. No production deploy or restart.
- [ ] Commit scoped changes and write observed results, limits and skipped work.
