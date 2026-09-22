# Refined Operations Console

## Decision and scope

The user selected option A: dark neutral surfaces, restrained indigo accents,
clear data hierarchy. Preserve SantaiNetwork branding, light mode, routes,
authentication, API payloads, realtime transports, and persisted state.
The user assigned DeepSeek to performance/Monaco, Kimi K3 (replacing GLM) to
visual design, and GPT-5.6-sol to navigation/skeletons/integration.
Implementation follows that selected direction, not another redesign round.

## Design

- Neutral layered surfaces, readable secondary text, semantic status colors.
  Target WCAG AA text contrast of 4.5:1. Status always includes text, not color alone.
- Metric cards have stable dimensions, tabular numbers, clear labels and quieter
  secondary content. Unknown/loading/error states must not imply healthy or zero.
- Desktop sidebar supports expanded and compact modes. Mobile navigation is a
  keyboard-accessible drawer with focus restoration, Escape dismissal and inert
  hidden content. Compact links remain named and show focus/hover tooltips.
- Header identifies the actual page and breadcrumb. Main content has a skip link.
- Content shrinks correctly at 375px. Wide tables scroll inside their own bounded,
  keyboard-accessible regions with sticky headers. Controls wrap rather than leak.
- Skeletons reserve useful card/table/editor space and respect reduced motion.
- Motion is short and restrained. No layout animation or decorative busy effects.
- Memoization only where stable props prevent measurable repeat work. Keep the
  existing stream and polling contracts, cleanup handlers and state ownership.
- Monaco already uses next/dynamic. Retain SSR isolation, add stable loading UI
  and defer unnecessary editor mounts without claiming an unmeasured bundle win.

## Safety

No backend/DB/Go/routing/deployment changes. Do not use production credentials or
mutate production settings for browser acceptance. Use an isolated local data
directory and loopback frontend preview. No new runtime dependency.
Do not infer provider fallback from missing data. Preserve actual upstream model
display. Existing token saver behavior is outside this UI-only change.

## Evidence boundary

Read-only audit suggestions are hypotheses, not verified defects. In particular,
claims of Monaco worker failures and a specific bundle saving need reproduction.
Build success alone cannot prove keyboard, contrast, responsiveness, or rendering
improvements. Report blocked browser paths honestly if browser automation fails.
