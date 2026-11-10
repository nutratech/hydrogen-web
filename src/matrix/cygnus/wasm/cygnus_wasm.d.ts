/* tslint:disable */
/* eslint-disable */

/**
 * Content hash of an event as unpadded base64url.
 *
 * # Errors
 * Throws if the event is not valid canonical JSON.
 */
export function contentHash(event_json: string): string;

/**
 * Matrix v3 event ID (`$` plus reference hash) of an event.
 *
 * # Errors
 * Throws if the event is not valid canonical JSON.
 */
export function eventId(event_json: string): string;

/**
 * Parse a principal (`~server` or `@user`) and return its canonical form.
 *
 * # Errors
 * Throws if the identifier is padded, the wrong length or not base64url.
 */
export function parsePrincipal(id: string): string;

/**
 * Return the active signature algorithm identifier used for event key IDs.
 */
export function signatureAlgorithm(): string;

/**
 * Return the encoded signature size in bytes for the active profile.
 */
export function signatureLength(): number;

/**
 * Verify a link chain given as base64url links, genesis first, and return
 * the principal that the chain identifies.
 *
 * # Errors
 * Throws on the first link that fails to parse or verify.
 */
export function verifyChain(links: string[]): string;

/**
 * Verify a custodian (server) WOTS+ signature over an event at a chain
 * height, using its certified 32-byte Merkle-root key.
 *
 * `height` is a decimal string, since protocol heights are `u64` and exceed
 * what a JS number represents exactly.
 *
 * # Errors
 * Throws if the signature entry is missing, malformed or invalid.
 */
export function verifyCustodianSignature(event_json: string, custodian: string, height: string, public_key: string): void;

/**
 * Verify a device's WOTS+ signature over an event against its certified
 * 32-byte Merkle-root key.
 *
 * # Errors
 * Throws if the signature entry is missing, malformed or invalid.
 */
export function verifyDeviceSignature(event_json: string, sender: string, device_id: string, public_key: string): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly contentHash: (a: number, b: number) => [number, number, number, number];
    readonly eventId: (a: number, b: number) => [number, number, number, number];
    readonly parsePrincipal: (a: number, b: number) => [number, number, number, number];
    readonly signatureAlgorithm: () => [number, number];
    readonly signatureLength: () => number;
    readonly verifyChain: (a: number, b: number) => [number, number, number, number];
    readonly verifyCustodianSignature: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly verifyDeviceSignature: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __externref_table_alloc: () => number;
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
