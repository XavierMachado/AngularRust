import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * What this client is, next to the Lit one. The measured numbers live in
 * COMPARISON.md at the repository root; this page is the short version.
 */
@Component({
  selector: 'wt-about-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel">
      <span class="eyebrow">Two consoles, one server</span>
      <h2>About this client</h2>

      <p>
        This is the same WebTransport console twice over: this Angular 20 build in
        <code>client/</code> and a second one, built from Lit 3, Vaadin Router, Vite and TC39
        signals in <code>client-lit/</code>. Both speak the identical wire protocol to the same Rust
        server, share the same Rust-compiled wasm module, the same hand-rolled design system, and
        the same three routed pages. The protocol and transport layer — framing, lanes, negotiation,
        both links — moved between them nearly unchanged, because it never depended on a framework
        in the first place.
      </p>

      <table>
        <thead>
          <tr>
            <th></th>
            <th>This console</th>
            <th>Lit console</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Components</td>
            <td>Angular 20, zoneless, standalone</td>
            <td>Lit 3 web components</td>
          </tr>
          <tr>
            <td>Reactivity</td>
            <td>Angular signals</td>
            <td>TC39 signals polyfill + SignalWatcher</td>
          </tr>
          <tr>
            <td>UI controls</td>
            <td>hand-styled native elements</td>
            <td>the same, adopted per shadow root</td>
          </tr>
          <tr>
            <td>Routing</td>
            <td>Angular Router (this page is lazy-loaded)</td>
            <td>Vaadin Router (same three routes)</td>
          </tr>
          <tr>
            <td>Build</td>
            <td>Angular CLI / esbuild</td>
            <td>Vite</td>
          </tr>
          <tr>
            <td>State</td>
            <td>injectable service</td>
            <td>module-level store, no DI</td>
          </tr>
          <tr>
            <td>Installed packages</td>
            <td>445</td>
            <td>69</td>
          </tr>
          <tr>
            <td>Initial payload, gzipped</td>
            <td>100.3 kB</td>
            <td>37.7 kB</td>
          </tr>
        </tbody>
      </table>

      <p>
        The measured numbers — install footprint, build times, bundle sizes, line counts — and the
        judgement calls behind both stacks live in <code>COMPARISON.md</code> at the repository
        root.
      </p>
    </section>
  `,
  styles: `
    :host {
      display: block;
      max-width: 72ch;
    }

    p,
    td {
      font-size: 0.86rem;
      line-height: 1.6;
    }

    p {
      color: var(--ink-2);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      margin: 14px 0;
      font: 400 0.8rem/1.5 var(--font-data);
    }

    th,
    td {
      text-align: left;
      padding: 6px 10px 6px 0;
      border-bottom: 1px solid var(--rule);
      vertical-align: top;
    }

    th {
      font: 500 0.66rem/1.6 var(--font-data);
      text-transform: uppercase;
      letter-spacing: 0.11em;
      color: var(--ink-2);
    }

    code {
      font-family: var(--font-data);
      font-size: 0.95em;
    }
  `,
})
export class AboutPage {}
