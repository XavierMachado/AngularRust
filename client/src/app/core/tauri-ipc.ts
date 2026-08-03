/**
 * The desktop shell's IPC doorway, if this page is running inside it.
 *
 * The shell exposes `window.__TAURI__` (its `withGlobalTauri` option) rather
 * than this client importing `@tauri-apps/api` — the console stays a plain web
 * app with no desktop dependency, and in a browser this simply returns null.
 * Structurally typed for the same reason `webtransport.types.ts` is: the seam
 * in `net.ts` can hand a fake to the tests.
 */

export interface TauriIpc {
  invoke<T>(
    command: string,
    payload?: unknown,
    options?: { headers?: Record<string, string> },
  ): Promise<T>;
  listen(event: string, handler: (event: { payload: unknown }) => void): Promise<() => void>;
}

interface TauriGlobal {
  core?: { invoke?: unknown };
  event?: { listen?: unknown };
}

export function getTauriIpc(): TauriIpc | null {
  const tauri = (globalThis as Record<string, unknown>)['__TAURI__'] as TauriGlobal | undefined;
  const invoke = tauri?.core?.invoke;
  const listen = tauri?.event?.listen;

  if (typeof invoke !== 'function' || typeof listen !== 'function') {
    return null;
  }

  return {
    invoke: invoke as TauriIpc['invoke'],
    listen: listen as TauriIpc['listen'],
  };
}
