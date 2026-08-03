import { css } from 'lit';

/**
 * The panel anatomy every card shares: the lane bar along the top edge, the
 * eyebrow, the muted lede. The Angular client keeps these as global classes;
 * shadow DOM does not do globals, so here they are a `CSSResult` each
 * component adopts. The custom properties they read still come from `:root` —
 * tokens inherit across shadow boundaries even though selectors do not.
 */
export const panelStyles = css`
  :host {
    display: block;
  }

  .panel {
    position: relative;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: 14px;
    padding: 20px 22px 22px;
    overflow: hidden;
    height: 100%;
  }

  /* The lane bar. Reading a panel's top edge tells you which guarantee it uses. */
  .panel.reliable::before,
  .panel.unreliable::before {
    content: '';
    position: absolute;
    inset: 0 0 auto;
    height: 3px;
  }

  .panel.reliable::before {
    background: var(--reliable);
  }

  .panel.unreliable::before {
    background: var(--unreliable);
  }

  .panel h2 {
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

  .panel.unreliable .eyebrow {
    color: var(--unreliable);
  }

  .panel.reliable .eyebrow {
    color: var(--reliable);
  }

  .lede {
    margin: 0 0 14px;
    color: var(--ink-2);
    font-size: 0.83rem;
    line-height: 1.5;
  }

  ol::-webkit-scrollbar {
    width: 10px;
  }

  ol::-webkit-scrollbar-thumb {
    background: var(--rule);
    border-radius: 999px;
    border: 3px solid var(--paper);
  }
`;

/**
 * Shoelace controls, wearing this app's identity: ink-filled pill buttons that
 * hover into the lane colour, the way the Angular client's native buttons do.
 * Lives in each component's shadow root because \`::part\` cannot be reached
 * from a document-level stylesheet across the host boundary.
 */
export const controlStyles = css`
  sl-button::part(base) {
    border-radius: 999px;
    font: 500 0.78rem/1 var(--font-body);
    background: var(--ink);
    border-color: var(--ink);
    color: var(--surface);
    transition:
      background 120ms ease,
      color 120ms ease;
  }

  sl-button::part(base):hover {
    background: var(--reliable);
    border-color: var(--reliable);
    color: var(--surface);
  }

  .panel.unreliable sl-button::part(base):hover {
    background: var(--unreliable);
    border-color: var(--unreliable);
  }

  sl-button.ghost::part(base) {
    background: transparent;
    color: var(--ink);
    border-color: var(--rule);
  }

  sl-button.ghost::part(base):hover {
    background: var(--reliable);
    border-color: var(--reliable);
    color: var(--surface);
  }

  .panel.unreliable sl-button.ghost::part(base):hover {
    background: var(--unreliable);
    border-color: var(--unreliable);
  }

  sl-input,
  sl-select {
    font-family: var(--font-data);
  }
`;
