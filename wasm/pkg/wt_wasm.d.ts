/* tslint:disable */
/* eslint-disable */

/**
 * One decoded lane message. The body stays bytes: the caller knows from the
 * lane whether to decode it as text or count it as bulk.
 */
export class DecodedLane {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly body: Uint8Array;
    readonly lane: number;
    readonly stream: number;
}

/**
 * The shared chunk-boundary decoder, holding buffered bytes between pushes.
 */
export class WasmFrameDecoder {
    free(): void;
    [Symbol.dispose](): void;
    constructor();
    /**
     * Feeds one chunk in, gets zero or more complete frame bodies out, each
     * as a JSON string for the caller to `JSON.parse`.
     */
    push(chunk: Uint8Array): string[];
    /**
     * True when a partial frame is still buffered.
     */
    readonly has_partial_frame: boolean;
}

/**
 * Splits one received message into its lane, stream id and body, throwing on
 * a short header, an unknown lane, or an oversized JSON body.
 */
export function decode_lane(message: Uint8Array): DecodedLane;

/**
 * Wraps one JSON-encoded message in a length-prefixed frame.
 */
export function encode_frame(json: string): Uint8Array;

/**
 * Prefixes a message with its lane and stream id, for transports that carry
 * every lane on one channel. See `wt_shared::lane`.
 *
 * `stream` is an f64 because that is what a JavaScript number is. Upload ids
 * are small counters, so the 2^53 an f64 holds exactly is not a limit anyone
 * will reach.
 */
export function encode_lane(lane: number, stream: number, body: Uint8Array): Uint8Array;

/**
 * Fibonacci as a decimal string — the same `wt_shared::compute::fib` the
 * server runs, so the browser and the server cannot disagree.
 */
export function fib(n: number): string;

/**
 * Bytes the way people write them. Takes an f64 because that is what a
 * JavaScript number is; the shared implementation wants a u64.
 */
export function human_bytes(bytes: number): string;

/**
 * Reverses by character, exactly as the server would.
 */
export function reverse(text: string): string;

/**
 * Applies the server's own `Say` rules. Returns the trimmed
 * `{"author":...,"text":...}` as JSON, or throws the exact message the
 * server would reply with.
 */
export function validate_say(author: string, text: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_decodedlane_free: (a: number, b: number) => void;
    readonly __wbg_wasmframedecoder_free: (a: number, b: number) => void;
    readonly decode_lane: (a: number, b: number) => [number, number, number];
    readonly decodedlane_body: (a: number) => [number, number];
    readonly decodedlane_lane: (a: number) => number;
    readonly decodedlane_stream: (a: number) => number;
    readonly encode_frame: (a: number, b: number) => [number, number, number, number];
    readonly encode_lane: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly fib: (a: number) => [number, number, number, number];
    readonly human_bytes: (a: number) => [number, number];
    readonly reverse: (a: number, b: number) => [number, number];
    readonly validate_say: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly wasmframedecoder_has_partial_frame: (a: number) => number;
    readonly wasmframedecoder_new: () => number;
    readonly wasmframedecoder_push: (a: number, b: number, c: number) => [number, number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_drop_slice: (a: number, b: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
