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
 * Issue a version-1 `device_certificate` (JSON text): the master key
 * certifies the self-signing key, which certifies the device key.
 *
 * # Errors
 * Throws for a non-user sender, an invalid device ID or a malformed seed.
 */
export function createDeviceCertificate(sender: string, master_seed: string, self_signing_seed: string, device_id: string, device_seed: string): string;

/**
 * Matrix v3 event ID (`$` plus reference hash) of an event.
 *
 * # Errors
 * Throws if the event is not valid canonical JSON.
 */
export function eventId(event_json: string): string;

/**
 * Parse one link without verifying it, returning its fields as JSON text:
 * `kind` (`"user"`/`"server"`), `height` (decimal string), `principal`, and
 * for user links `custodian` (`~` ID), `master_key`, `display_user_id`, or for
 * server links `server_name` and `online_key`; the other kind's fields are
 * `null`. Pair it with [`verify_chain`] before trusting any field.
 *
 * # Errors
 * Throws if the link is not well-formed base64url link bytes.
 */
export function parseLink(link_b64: string): string;

/**
 * Parse a principal (`~server` or `@user`) and return its canonical form.
 *
 * # Errors
 * Throws if the identifier is padded, the wrong length or not base64url.
 */
export function parsePrincipal(id: string): string;

/**
 * Ed25519 public key for a 32-byte seed, as unpadded base64url.
 *
 * # Errors
 * Throws if the seed is not 32 bytes of base64url.
 */
export function publicKey(seed: string): string;

/**
 * Rotation commitment `C = commitment(K_rot)` for a rotation seed, as sent to
 * the server in the §7 principal request.
 *
 * # Errors
 * Throws if the seed is not 32 bytes of base64url.
 */
export function rotationCommitment(rotation_seed: string): string;

/**
 * Set the content hash and add the device signature to an event that
 * already carries its `device_certificate`; returns the signed event JSON.
 * The custodian signature is added by the server.
 *
 * # Errors
 * Throws if the event is not valid JSON or a seed is malformed.
 */
export function signEvent(event_json: string, sender: string, device_id: string, device_seed: string): string;

/**
 * Extend a user chain: sign the next link with the rotation key the parent
 * committed to, committing to `nextRotationSeed` for the following link.
 *
 * `custodian` is the custodian server's 32-byte principal root (base64url).
 *
 * # Errors
 * Throws if the parent is not a user link, the current rotation seed does
 * not match its commitment, or the master key differs from the parent's.
 */
export function userSuccessor(parent_link: string, current_rotation_seed: string, next_rotation_seed: string, custodian: string, master_pub: string, display_user_id: string): string;

/**
 * Verify a link chain given as base64url links, genesis first, and return
 * the principal that the chain identifies.
 *
 * # Errors
 * Throws on the first link that fails to parse or verify.
 */
export function verifyChain(links: string[]): string;

/**
 * Verify a custodian (server) signature over an event at a chain height.
 *
 * `height` is a decimal string, since protocol heights are `u64` and exceed
 * what a JS number represents exactly.
 *
 * # Errors
 * Throws if the signature entry is missing, malformed or invalid.
 */
export function verifyCustodianSignature(event_json: string, custodian: string, height: string, public_key: string): void;

/**
 * Verify a device's signature over an event against its certified key.
 *
 * # Errors
 * Throws if the signature entry is missing, malformed or invalid.
 */
export function verifyDeviceSignature(event_json: string, sender: string, device_id: string, public_key: string): void;

/**
 * Check the server's §7 `POST /principal` response against the rotation
 * seed and master key the client sent, and return the genesis link.
 *
 * # Errors
 * Throws if the principal, link count, master key or commitment does not
 * match the request.
 */
export function verifyUserPrincipalResponse(rotation_seed: string, master_pub: string, principal: string, links: string[]): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly contentHash: (a: number, b: number) => [number, number, number, number];
    readonly createDeviceCertificate: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number, number];
    readonly eventId: (a: number, b: number) => [number, number, number, number];
    readonly parseLink: (a: number, b: number) => [number, number, number, number];
    readonly parsePrincipal: (a: number, b: number) => [number, number, number, number];
    readonly publicKey: (a: number, b: number) => [number, number, number, number];
    readonly rotationCommitment: (a: number, b: number) => [number, number, number, number];
    readonly signEvent: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly userSuccessor: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number, number, number];
    readonly verifyChain: (a: number, b: number) => [number, number, number, number];
    readonly verifyCustodianSignature: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly verifyDeviceSignature: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly verifyUserPrincipalResponse: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
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
