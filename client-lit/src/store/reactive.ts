/**
 * The store's entire reactive vocabulary, over the TC39 signals proposal.
 *
 * `@lit-labs/signals` re-exports `signal-polyfill`'s `Signal.State` and
 * `Signal.Computed`, so nothing here depends on Lit itself — the store built on
 * these helpers runs under plain Node, which is what its spec does.
 */

import { Signal, computed, signal } from '@lit-labs/signals';

export { computed, signal };
export type State<T> = Signal.State<T>;
export type Computed<T> = Signal.Computed<T>;

/** The polyfill has no `update`; the store's reducers want one. */
export function update<T>(target: Signal.State<T>, fn: (value: T) => T): void {
  target.set(fn(target.get()));
}
