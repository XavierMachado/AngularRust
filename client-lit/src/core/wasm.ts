/**
 * The typed doorway to the rest of `wt-shared` running in this tab: the same
 * compute and validation the server executes, minus the network. Framing has
 * its own facade in `framing.ts`.
 */

import { fib, human_bytes, reverse, validate_say } from 'wt-wasm';

/** A `Say` that passed the server's rules, trimmed the way the server trims. */
export interface ValidatedSay {
  author: string;
  text: string;
}

/**
 * Fibonacci as a decimal string. Throws exactly the message the server would
 * reply with when `n` is over the limit.
 */
export function fibLocal(n: number): string {
  return fib(n);
}

/** Reverse by character, exactly as the server does it. */
export function reverseLocal(text: string): string {
  return reverse(text);
}

/** `1536` -> `1.5 KiB`, matching the server's own formatting. */
export function humanBytes(bytes: number): string {
  return human_bytes(bytes);
}

/**
 * The server's `Say` rules: trim, bound, default a blank author. Throws with
 * the server's exact error for an empty message — so a request the server
 * would refuse never leaves this tab.
 */
export function validateSay(author: string, text: string): ValidatedSay {
  return JSON.parse(validate_say(author, text)) as ValidatedSay;
}
