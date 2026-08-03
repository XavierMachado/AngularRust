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
 * The control chrome, identical to the Angular client's global input and
 * button rules. Native elements need no component library: the design was
 * always a handful of CSS on `<button>` and `<input>`, and shadow DOM only
 * means each component adopts it explicitly instead of inheriting a global.
 */
export const controlStyles = css`
  input,
  select {
    font: 400 0.85rem/1 var(--font-data);
    color: var(--ink);
    background: #fff;
    border: 1px solid var(--rule);
    border-radius: 8px;
    padding: 9px 11px;
  }

  select {
    font-size: 0.74rem;
    padding: 9px 10px;
  }

  input:disabled {
    background: var(--paper);
    color: var(--ink-2);
  }

  button {
    font: 500 0.78rem/1 var(--font-body);
    color: var(--surface);
    background: var(--ink);
    border: 1px solid var(--ink);
    border-radius: 999px;
    padding: 10px 16px;
    cursor: pointer;
    transition:
      background 120ms ease,
      color 120ms ease;
  }

  button:hover:not(:disabled) {
    background: var(--reliable);
    border-color: var(--reliable);
  }

  .panel.unreliable button:hover:not(:disabled) {
    background: var(--unreliable);
    border-color: var(--unreliable);
  }

  button.ghost {
    background: transparent;
    color: var(--ink);
    border-color: var(--rule);
  }

  button.ghost:hover:not(:disabled) {
    color: var(--surface);
  }

  button.small {
    padding: 6px 12px;
    font-size: 0.7rem;
  }

  button:disabled,
  input:disabled,
  select:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  :focus-visible {
    outline: 2px solid var(--unreliable);
    outline-offset: 2px;
  }
`;
