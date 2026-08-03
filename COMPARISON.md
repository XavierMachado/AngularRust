# Angular vs. Lit + Vaadin Router + Vite + Signals

The same application, built twice, now genuinely like for like. `client/` is Angular 20
(standalone, zoneless, signals, Angular Router); `client-lit/` is Lit 3 + Vaadin Router + Vite +
the TC39 signals polyfill. Both speak the identical wire protocol to the same Rust server, load
the same wasm module, pass the same vitest specs against the same committed wasm binary, share one
hand-rolled design system — native buttons, inputs and selects styled by the same CSS — and both
have the same three routed pages (`/` console, `/log`, `/about`), with `/log` and `/about`
lazy-loaded in each.

An earlier revision of the Lit client used Shoelace for its controls. It was dropped: measured
here, it roughly doubled the Lit bundle (~74 kB → ~38 kB gzipped initial after removal) to replace
controls this design already defines in a few dozen lines of CSS. The note at the end covers when
that trade goes the other way.

Everything below was measured on one machine (Linux container, Node v22.22.2, npm 10.9.7), same
day, with the commands shown at the end. Build medians are over three runs. The 87 kB wasm file is
byte-identical in both bundles and excluded from bundle numbers.

## Measurements

### Dependency footprint

| Metric | Angular | Lit stack |
| --- | ---: | ---: |
| Direct runtime deps (incl. local `wt-wasm`) | 9 | 4 |
| Installed packages (`npm ls --all`) | **445** | **69** |
| `node_modules` on disk | 257 MB | 69 MB |
| `npm install`, warm cache | 9.3 s | 2.0 s |

The Lit stack's four runtime deps are `lit`, `@lit-labs/signals`, `@vaadin/router` and the local
`wt-wasm`; dev deps are `vite`, `typescript`, `vitest`, `prettier`. All 69 installed packages fit
on one screen and can be audited in an afternoon. The Angular side's 445 are overwhelmingly the
CLI's build toolchain — not shipped to the browser, but installed, resolved, and on the update
treadmill.

### Build and dev loop

| Metric | Angular | Lit stack |
| --- | ---: | ---: |
| Production build, cold (`rm -rf .angular` / `node_modules/.vite`) | 8.5 s | 3.7 s |
| Production build, warm (median of 3) | 4.4 s | 3.9 s |
| Dev server ready, cold | 4.0 s | 0.5 s |

The Lit `build` runs a full `tsc --noEmit` then Vite; most of its time is the type check, which
Angular's build also performs. Warm builds are close. The cold start and the eight-times-faster
dev server are where Vite's on-demand model shows.

### Bundle size (gzip −9, excluding the shared 87 kB wasm)

| Metric | Angular | Lit stack |
| --- | ---: | ---: |
| **Initial payload** (what `/` loads) | **100.3 kB** | **37.7 kB** |
| Lazy chunks (`/log` + `/about`) | 3.2 + 1.5 kB | 2.9 + 1.6 kB |
| Total JS + CSS | 105.0 kB | 44.2 kB |
| Total raw (uncompressed) | 333.9 kB | 123.9 kB |

With both apps carrying a real router and identical features, the Lit build's initial payload is
**2.7× smaller**. Two things moved since the earlier Shoelace revision measured a tie: dropping
Shoelace cut the Lit bundle roughly in half, and Angular Router raised the Angular baseline from
75.5 kB to 100.3 kB. Route-level code-splitting works equivalently well in both — a lazy page
costs 1.5–3 kB either way.

That last row is also the growth curve in miniature: the marginal cost of a new page is the same
small number in both stacks, so the 62 kB gap is a fixed framework baseline, not something that
compounds. What does compound is dependency count — every Angular feature module (forms already
here; i18n, animations, PWA) arrives on the same release train, while the Lit side adds nothing
until you choose it.

### Source size

| Metric (lines) | Angular | Lit stack |
| --- | ---: | ---: |
| Source total (`src/**` ts+css+html) | 4,501 | 4,973 |
| — of which specs | 529 | 726 |
| — non-spec application code | 3,972 | 4,247 |
| Config (`angular.json`/`vite.config.ts`, tsconfigs, vitest, `package.json`) | 174 | 90 |
| Core moved between the two **byte-identical** | — | 1,721 (14 files) |

Feature-for-feature, the code is nearly the same size. The Lit side's ~270 extra non-spec lines
are style adoption: real shadow DOM cannot read a global stylesheet, so the shared `.panel`,
button and input rules live in `shared-styles.ts` and every component adopts them explicitly.
That's the trade for components that work in any framework or none. The Lit spec count is higher
because it has a test the Angular side doesn't: a 197-line store spec driving the full
connect/welcome/say/teardown lifecycle in plain Node — possible because the store is a class that
takes its dependencies as constructor arguments, no TestBed or DI container required.

The most important number is the last row: 14 files — protocol types, framing and lane facades,
negotiation, the correlation map, both transport links, four spec files — moved between frameworks
**without a single edited line**. Only `net.ts` (an `InjectionToken` became a constructor
argument) and the store (Angular `signal()` became TC39 `Signal.State`, ~40 mechanical call-site
edits in 564 lines) needed touching. The transport layer was never Angular code or Lit code; it
was TypeScript.

## Qualitative differences

### Reactivity

Near-identical mental model: `signal`/`computed`, fine-grained updates, no zones on either side.
Angular's signals are a stable first-party primitive. The Lit side uses the TC39 proposal's
polyfill via `@lit-labs/signals`, whose `SignalWatcher` mixin re-renders a component when any
signal it read during `render()` changes — pleasant and terse, but pre-1.0 `labs` tracking a
moving proposal. Pin it exactly; the store itself only uses `signal`/`computed`/`.get`/`.set` and
would port to raw `signal-polyfill` in minutes if the labs package churned.

### Templates and type safety

The clearest Angular win. With `strictTemplates`, a renamed store property or misspelled input
fails the *build*. lit-html templates are tagged strings: expressions inside `${}` are
type-checked, but binding names (`?disabled=`, `@change=`, `.value=`) are not — a typo there fails
silently at runtime. `lit-analyzer` recovers much of this in the editor, but it is not in the
build gate. On a large team this difference compounds with codebase size.

### Components and styles

Both apps now style native elements with the same CSS. The difference is delivery: Angular's
emulated encapsulation lets one global stylesheet reach every component, while Lit's real shadow
DOM makes each component adopt shared `CSSResult`s explicitly. More ceremony, ~260 lines of it —
in exchange, encapsulation actually encapsulates, and every `wt-*` element is a plain custom
element usable from any framework or none. Design tokens flow through either way: CSS custom
properties inherit across shadow boundaries, which is why the canvas ledger reads its colours off
`getComputedStyle` unchanged in both apps.

On component libraries: this app didn't need one — its design system is a few dozen lines of CSS
on native elements, and Shoelace was measured here to double the bundle to replace them. That math
flips for form-heavy products that would otherwise hand-build dialogs, comboboxes, date pickers
and their accessibility. Reach for a library when it replaces code you'd have to write, not when
it replaces CSS you already wrote.

### Routing

Both routers do the same job here — three routes, lazy page chunks, redirect fallback, active-link
styling, SPA deep links through the Rust server's static fallback — at roughly the same marginal
cost per page. Angular Router is first-party, on the release train, and grows features (guards,
resolvers, nested outlets) without new dependencies; it costs ~14 kB gzipped and two more
packages. Vaadin Router is ~30 lines of route table and one small dependency — but it is in
maintenance mode, which is the third-party-ecosystem risk in microcosm. The exposure is contained
(the used surface is stable and the route table ports to any history-API router in an hour), but
it is real, and it is the recurring pattern of the small-stack approach: each piece is easy to
replace, and one day you may have to.

### What didn't change at all

The Rust server, the wire protocol, the wasm boundary, the visual design, and 1,721 lines of
transport core. Both consoles connect to the same server at once and see each other's chat
messages. The strongest finding of the whole exercise: keeping domain and transport logic
framework-free is worth more than either framework choice.

## Reading the result

- **The Lit stack** (lit + signals + a small router + Vite) now wins the quantitative comparison
  outright for this kind of app: 69 packages against 445, a 2.7× smaller initial payload, a 2 s
  install and a half-second dev server — while shipping the identical product. Its costs are
  process, not product: no template type-checking in the build gate, conventions the team owns
  itself (style adoption, event-name discipline), and small dependencies you must be willing to
  replace (Vaadin Router's maintenance mode being the live example).
- **Angular** buys a first-party platform: `strictTemplates` catching template errors at build
  time, router/forms/i18n on one coordinated release train, DI, and hiring/onboarding
  conventions. The price is measured above and is mostly paid in tooling weight and a fixed
  ~60 kB bundle baseline — no longer in runtime overhead, now that zoneless signals are the
  default way to write it.
- **Either way**, keep the core framework-free. It is the only part of this codebase that has now
  outlived a framework decision, twice.

## Reproducing the numbers

```bash
# deps
cd client     && npm ls --all --parseable | sort -u | wc -l && du -sh node_modules
cd client-lit && npm ls --all --parseable | sort -u | wc -l && du -sh node_modules

# builds (cold, then warm ×3)
cd client     && rm -rf .angular dist           && time npm run build && time npm run build
cd client-lit && rm -rf node_modules/.vite dist && time npm run build && time npm run build

# bundles, gzipped per file (wasm excluded; it is byte-identical in both)
for f in client/dist/console/browser/*.{js,css}; do echo "$f $(gzip -9c "$f" | wc -c)"; done
for f in client-lit/dist/assets/*.{js,css}; do echo "$f $(gzip -9c "$f" | wc -c)"; done

# source lines
find client/src -name '*.ts' -o -name '*.css' -o -name '*.html' | xargs wc -l | tail -1
find client-lit/src -name '*.ts' -o -name '*.css' | xargs wc -l | tail -1

# the byte-identical core
for f in client-lit/src/core/*.ts; do diff -q "client/src/app/core/$(basename "$f")" "$f"; done
```
