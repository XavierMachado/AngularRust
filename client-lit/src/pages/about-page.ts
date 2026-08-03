import { LitElement, css, html } from 'lit';
import { customElement } from 'lit/decorators.js';

/**
 * What this client is, next to the Angular one. The measured numbers live in
 * COMPARISON.md at the repository root; this page is the short version.
 */
@customElement('wt-about-page')
export class AboutPage extends LitElement {
  static override styles = css`
    :host {
      display: block;
      max-width: 72ch;
    }

    .panel {
      position: relative;
      background: var(--surface);
      border: 1px solid var(--rule);
      border-radius: 14px;
      padding: 20px 22px 22px;
    }

    h2 {
      margin: 2px 0 12px;
      font-family: var(--font-display);
      font-weight: 700;
      letter-spacing: -0.015em;
      font-size: 1.25rem;
    }

    .eyebrow {
      display: inline-block;
      font: 500 0.66rem/1 var(--font-data);
      text-transform: uppercase;
      letter-spacing: 0.14em;
      color: var(--ink-2);
    }

    p,
    li {
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
  `;

  override render() {
    return html`
      <section class="panel">
        <span class="eyebrow">Two consoles, one server</span>
        <h2>About this client</h2>

        <p>
          This is the same WebTransport console twice over: an Angular 20 build in
          <code>client/</code> and this one, built from Lit 3, Vaadin Router, Vite and TC39 signals
          in <code>client-lit/</code>. Both speak the identical wire protocol to the same Rust
          server, share the same Rust-compiled wasm module, the same hand-rolled design system, and
          the same three routed pages. The protocol and transport layer — framing, lanes,
          negotiation, both links — moved between them nearly unchanged, because it never depended
          on a framework in the first place.
        </p>

        <table>
          <thead>
            <tr>
              <th></th>
              <th>Angular console</th>
              <th>This console</th>
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
              <td>Angular Router (same three routes)</td>
              <td>Vaadin Router (this page is lazy-loaded)</td>
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
          judgement calls behind this stack live in <code>COMPARISON.md</code> at the repository
          root.
        </p>
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'wt-about-page': AboutPage;
  }
}
