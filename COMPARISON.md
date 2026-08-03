# Angular vs. Lit + Shoelace + Vaadin Router + Vite + Signals

The same application, built twice. `client/` is Angular 20 (standalone, zoneless, signals);
`client-lit/` is Lit 3 + Shoelace + Vaadin Router + Vite + the TC39 signals polyfill. Both speak
the identical wire protocol to the same Rust server, load the same wasm module, pass the same
vitest specs against the same committed wasm binary, and carry the same visual design. The Lit
client additionally splits the console into three routed pages (`/`, `/log`, `/about`), because
exercising a router was part of the point.

Everything here was measured on one machine (Linux container, Node v22.22.2, npm 10.9.7), same
day, with the exact commands shown. Timings are a single representative run unless noted;
build-time medians are over three runs. The 87 kB wasm file is byte-identical in both bundles and
is excluded from bundle-size numbers.

## Measurements

### Dependency footprint

| Metric | Command | Angular | Lit stack |
| --- | --- | ---: | ---: |
| Direct runtime deps | `package.json` `dependencies` (incl. `wt-wasm`) | 8 | 5 |
| Installed packages | `npm ls --all --parseable \| sort -u \| wc -l` | **444** | **80** |
| `node_modules` on disk | `du -sh node_modules` | 256 MB | 99 MB |
| `npm install`, warm cache | `rm -rf node_modules && time npm install` | 9.6 s | 6.7 s |

The headline gap. The Lit stack's five runtime deps are `lit`, `@shoelace-style/shoelace`,
`@vaadin/router`, `@lit-labs/signals` and the local `wt-wasm`; dev deps are `vite`, `typescript`,
`vitest`, `prettier`. Every one of the 80 installed packages can be listed on one screen and
audited in an afternoon. The Angular side's 444 packages are overwhelmingly the CLI's build
toolchain — not shipped to the browser, but installed, resolved, and on the update treadmill.

### Build and dev loop

| Metric | Angular | Lit stack |
| --- | ---: | ---: |
| Production build, cold (`rm -rf .angular` / `node_modules/.vite`) | 12.6 s | 4.5 s |
| Production build, warm (median of 3) | 4.6 s | 4.5 s |
| Dev server ready, cold | 4.0 s | 0.4 s |

The Lit `build` script runs a full `tsc --noEmit` and then Vite; almost all of its 4.5 s is the
type check, which Angular's build also performs. Warm builds are a wash. The cold numbers and the
ten-times-faster dev-server start are where Vite's on-demand model shows.

### Bundle size (gzip −9, excluding the shared 87 kB wasm)

| Metric | Angular | Lit stack |
| --- | ---: | ---: |
| JS + CSS, raw | 239.1 kB | 287.8 kB |
| JS + CSS, gzipped | 75.5 kB | 81.5 kB |
| **Initial payload, gzipped** (what `/` loads) | **75.5 kB** | **74.3 kB** |
| Lazy chunks, gzipped (`/log`, `/about`) | — | 5.6 + 1.6 kB |

The honest surprise: **initial payload is a tie**. "Lit is tiny" is true of Lit itself (~15 kB),
but Shoelace's form controls are full-featured web components and cost real bytes, and Angular
20's tree-shaking is excellent — a zoneless signals app ships none of the framework's legacy
weight. The Lit build does get code-splitting for free via the router (`/log` and `/about` arrive
only when visited), which the single-page Angular app has no occasion for. If bundle size is the
deciding metric, neither stack wins this comparison; if install footprint is, the Lit stack wins
it outright.

### Source size

| Metric (lines) | Angular | Lit stack |
| --- | ---: | ---: |
| Source total (`src/**` ts+css+html) | 4,268 | 4,984 |
| — of which specs | 529 | 727 |
| — non-spec application code | 3,739 | 4,257 |
| Config (`angular.json`/`vite.config.ts`, tsconfigs, vitest, `package.json`) | 174 | 90 |
| Core moved between the two **byte-identical** | — | 1,721 (14 files) |

The Lit side is ~500 lines *larger*, for identifiable reasons: an extra page (`/about`), the
router and shell/page split, a 198-line store spec the Angular side doesn't have, and
~180 lines of `shared-styles.ts` — panel CSS that Angular kept in one global stylesheet but real
shadow DOM forces each component to adopt explicitly. Framework choice did not meaningfully change
how much code the *features* take.

The most important number is the last row: 14 files, 1,721 lines — protocol types, framing and
lane facades, negotiation, the correlation map, both transport links, and four spec files — moved
between frameworks **without a single edited line**. Only `net.ts` (an `InjectionToken` became a
constructor argument) and the store (Angular `signal()` became TC39 `Signal.State`, ~40 mechanical
call-site edits in 564 lines) needed touching. The transport layer was never Angular code or Lit
code; it was TypeScript.

## Qualitative differences

### Reactivity

Near-identical mental model: `signal`/`computed`, fine-grained updates, no zones on either side.
Angular's signals are a stable, first-party primitive with framework-wide integration. The Lit
side uses the TC39 proposal's polyfill via `@lit-labs/signals`, whose `SignalWatcher` mixin makes
any signal read inside `render()` schedule a re-render — pleasant and terse, but the package is
pre-1.0 `labs` and the proposal is still moving. The store port was mechanical (`.get()`/`.set()`
instead of call syntax; an `update()` helper replaced Angular's). One thing Angular's DI never
allowed: the Lit store is a plain module-level singleton, constructed with its dependencies as
arguments — which is precisely why `transport.spec.ts` can drive the entire
connect/welcome/say/teardown lifecycle in plain Node with no TestBed, no DI container, no harness.

### Templates and type safety

The clearest Angular win. With `strictTemplates`, a renamed store property or a misspelled input
fails the *build*. lit-html templates are tagged strings: expressions inside `${}` are
type-checked by `tsc`, but binding names (`?disabled=`, `@sl-change=`, `.value=`) are not — a typo
there fails silently at runtime. `lit-analyzer` recovers some of this in the editor, but it is not
in the build gate. On a large team this difference compounds.

### Components and styles

Angular's emulated encapsulation let one global stylesheet define `.panel`, `.eyebrow` and button
chrome for every component. Lit's real shadow DOM is stricter: styles must be adopted per
component (`shared-styles.ts`), and Shoelace internals can only be reached through exported
`::part()`s from within a shadow scope that can see the element. That cost ~180 lines and some
`::part` plumbing — in exchange, encapsulation actually encapsulates: the components are plain
custom elements usable from any framework or none, and design tokens still flow through, because
CSS custom properties inherit across shadow boundaries (the canvas ledger reads its colours off
`getComputedStyle` unchanged).

### Shoelace

Buttons, inputs, selects and the copy button came ready-made with focus management and keyboard
behaviour the Angular side hand-rolled. Two costs: bytes (see above), and its event model
(`@sl-input`, not `@input`; miss it and the binding silently never fires). Restricting usage to
components whose icons come from Shoelace's built-in system library means zero runtime asset or
CDN fetches — worth guarding, since the default icon library resolves over HTTP. Shoelace is also
mid-transition to "Web Awesome"; the 2.x line is stable but not where new work happens.

### Routing

Vaadin Router did everything asked — shadow-DOM outlet, lazy `import()` per route, redirect
fallback, SPA deep links through the Rust server's static fallback — in ~30 lines. But it is in
maintenance mode, which is exactly the third-party-ecosystem risk Angular's first-party,
release-train router doesn't have. The exposure is contained (the route table is trivially
portable to any history-API router), but it is real, and it is the pattern with this stack in
general: each piece is small enough to replace, and you may someday have to.

### What didn't change at all

The Rust server, the wire protocol, the wasm boundary, the visual design, and 1,721 lines of
transport core. Both consoles connect to the same server at once and see each other's chat
messages. The strongest finding of the whole exercise: keeping domain and transport logic
framework-free is worth more than either framework choice.

## Reading the result

- **Pick the Lit stack** when the priorities are a small, auditable dependency surface (80 vs 444
  packages), a fast dev loop, framework-agnostic components, and code that outlives framework
  churn — and the team is comfortable owning more conventions itself (style sharing, event-name
  discipline, replacing a maintenance-mode router if it comes to that).
- **Pick Angular** when template type-checking in the build gate, first-party routing/forms/i18n
  on one release train, and hiring/onboarding conventions matter more than install footprint —
  its zoneless signals runtime is no longer paying any meaningful bundle tax for it.
- **Either way**, keep the core framework-free. It is the only part of this codebase that has now
  outlived a framework decision, twice.

## Reproducing the numbers

```bash
# deps
cd client     && npm ls --all --parseable | sort -u | wc -l && du -sh node_modules
cd client-lit && npm ls --all --parseable | sort -u | wc -l && du -sh node_modules

# builds (cold, then warm ×3)
cd client     && rm -rf .angular dist        && time npm run build && time npm run build
cd client-lit && rm -rf node_modules/.vite dist && time npm run build && time npm run build

# bundles (wasm excluded; it is byte-identical in both)
find client/dist/console/browser client-lit/dist -name '*.js' -o -name '*.css' \
  | while read f; do gzip -9 -c "$f" | wc -c; done

# source lines
find client/src -name '*.ts' -o -name '*.css' -o -name '*.html' | xargs wc -l | tail -1
find client-lit/src -name '*.ts' -o -name '*.css' | xargs wc -l | tail -1

# the byte-identical core
for f in client-lit/src/core/*.ts; do diff -q "client/src/app/core/$(basename "$f")" "$f"; done
```
