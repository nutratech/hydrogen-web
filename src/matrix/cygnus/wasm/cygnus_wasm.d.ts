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
 * Apply a received Commit, merge, or external Commit.
 *
 * `ctxJson` is `{"senderMember":"<principal:device>","ancestors":[event_id...]}`
 * (`roomId` may be present and is ignored). `registryJson` is required for
 * `m.dmls.merge` and ignored otherwise.
 *
 * Returns `{status:"applied", groupId, commitId, epoch, members,
 * extremityCount}`, `{status:"deferred", reason, extremityCount}`, or
 * `{status:"rejected", reason}`.
 *
 * # Errors
 * Throws for a malformed argument, an unknown group, or a missing registry.
 */
export function dmlsApplyCommit(group_id_json: string, event_type: string, content_json: string, ctx_json: string, registry_json?: string | null): string;

/**
 * Authorize a received `m.dmls.reboot` without changing local state.
 *
 * The sender must be an active member of the named base and every listed
 * member must be in it. A member that lost the base defers with
 * `missing_base_state`.
 *
 * Returns `{status:"accepted", newGroupId, members}` or `{status, reason}`.
 *
 * # Errors
 * Throws for a malformed argument or an unknown group.
 */
export function dmlsCheckReboot(group_id_json: string, content_json: string, ctx_json: string): string;

/**
 * Produce one Commit from a single membership operation.
 *
 * `opsJson` is one object: `{"op":"add","keyPackage":"<b64>"}`,
 * `{"op":"remove","member":"<principal:device>"}`, or
 * `{"op":"self_update"}`. `baseJson` is the held base extremity
 * (`{mls_epoch, commit_id, event_id}`); omit it only when the base is the
 * genesis state.
 *
 * Returns `{eventType, content, groupId, commitId, epoch, members, welcome,
 * recipients}`. A Welcome is `welcome` (base64url) plus `recipients`
 * (`[{toDevice:{principal,deviceId}, keyPackageId}]`); finish the to-device
 * content with `dmlsWelcomeContent` after the Commit event is published.
 *
 * # Errors
 * Throws for a malformed argument, a bad base, or an MLS failure.
 */
export function dmlsCommit(group_id_json: string, device_seed_b64: string, ops_json: string, base_json?: string | null): string;

/**
 * Create the epoch-0 group for `roomId` and install it locally.
 *
 * Returns `{groupId, commitId, epoch, members, stateB64}`. Nothing is
 * published; the first event is the epoch-1 Commit from `dmlsCommit`.
 *
 * # Errors
 * Throws for a malformed identity or seed, an already loaded group, or an MLS
 * failure.
 */
export function dmlsCreateGroup(identity_json: string, device_seed_b64: string, room_id: string): string;

/**
 * Decrypt one application message, trying every held state at its epoch.
 *
 * Returns `{status:"ok", innerType, innerContentJson, senderMember, epoch,
 * commitId}`, `{status:"missing_state", epoch}`, or
 * `{status:"rejected", reason}`.
 *
 * # Errors
 * Throws for a malformed argument or an unknown group.
 */
export function dmlsDecrypt(group_id_json: string, content_json: string, room_id: string): string;

/**
 * Encrypt one application message at the named branch or the sole tip.
 *
 * The §13 plaintext `{room_id, type, content}` is built inside wasm. `roomId`
 * is the room id; for a reboot group it does not hash to `groupId`.
 *
 * Returns `{eventType:"m.room.encrypted", content}`.
 *
 * # Errors
 * Throws for a malformed argument, an unknown group, an unheld branch, a
 * `fork_unresolved` ambiguous tip, or a seed that does not match the group.
 */
export function dmlsEncrypt(group_id_json: string, device_seed_b64: string, room_id: string, inner_type: string, inner_content_json: string, at_commit_id?: string | null): string;

/**
 * Serialize a loaded group to its versioned blob, base64url encoded.
 *
 * # Errors
 * Throws for an unknown group.
 */
export function dmlsExportGroup(group_id_json: string): string;

/**
 * Join a group by external Commit against a target extremity.
 *
 * `targetJson` is the target extremity (`{mls_epoch, commit_id, event_id}`)
 * and `sourceContentJson` is the content of the event that produced it. Wasm
 * checks that the source content's `mls_epoch`/`commit_id` are the target's
 * and takes `group_info` from it.
 *
 * Returns `{eventType, content, groupId, commitId, epoch, members}`.
 *
 * # Errors
 * Throws for a malformed argument, a mismatched source, or an MLS failure.
 */
export function dmlsExternalCommit(identity_json: string, device_seed_b64: string, room_id: string, target_json: string, source_content_json: string): string;

/**
 * Drop a group from wasm memory. The persisted blob is untouched.
 *
 * # Errors
 * Throws for a malformed group id.
 */
export function dmlsForget(group_id_json: string): void;

/**
 * Whether a group is loaded in this wasm instance.
 *
 * # Errors
 * Throws for a malformed group id.
 */
export function dmlsHasGroup(group_id_json: string): boolean;

/**
 * Import a group blob, replacing a loaded entry atomically.
 *
 * Returns `{groupId, seq, extremities, extremityCount}`.
 *
 * # Errors
 * Throws for a malformed blob, an unsupported version, or a stale `seq`.
 */
export function dmlsImportGroup(state_b64: string): string;

/**
 * Join a group from a received `m.dmls.welcome`.
 *
 * `welcomeContentJson` is the verified event content and `secretsB64` is the
 * stored secret for its `key_package_id`. A missing secret is
 * `{status:"wrong_key_package"}`. The group id comes from the content, so a
 * reboot replacement group joins the same way as a room-derived one.
 *
 * Returns `{status:"applied", groupId, commitId, epoch, members}` or
 * `{status, reason}`.
 *
 * # Errors
 * Throws for a malformed identity or an already loaded group.
 */
export function dmlsJoinWelcome(identity_json: string, device_seed_b64: string, welcome_content_json: string, secrets_b64?: string | null): string;

/**
 * Build a single-use key package and the secrets that redeem its Welcome.
 *
 * Returns `{eventType, content, keyPackageId, secretsB64}`. Persist
 * `secretsB64` keyed by `keyPackageId` before publishing `content`.
 *
 * # Errors
 * Throws for a malformed identity or seed, or an MLS failure.
 */
export function dmlsKeyPackage(identity_json: string, device_seed_b64: string): string;

/**
 * Plan and build an `m.dmls.merge` Commit.
 *
 * Inputs are as `dmlsPlanMerge`. The Commit resolves every requested state and
 * uses the plan's base. `keyPackagesJson` is an optional JSON array of
 * base64url KeyPackages, exactly one per member the plan Adds; a plan that
 * needs an Add without it is `rejected` with `missing_key_package`.
 *
 * Returns `{status:"merged", eventType, content, groupId, commitId, epoch,
 * members, welcome, recipients}` or `{status, reason}`.
 *
 * # Errors
 * Throws for a malformed argument or an MLS failure.
 */
export function dmlsMerge(group_id_json: string, device_seed_b64: string, requested_json: string, registry_json: string, key_packages_json?: string | null): string;

/**
 * Plan a merge over the held branches named by `requestedJson`.
 *
 * Each entry is `{"commit_id":"<b64url32>","event_id":"$..."}`; the epoch is
 * read from the held state. `registryJson` is the per-call device-root
 * registry (§5.1) and is never cached.
 *
 * Returns `{status:"planned", plan}` or `{status, reason}`.
 *
 * # Errors
 * Throws for a malformed argument or corrupt stored metadata.
 */
export function dmlsPlanMerge(group_id_json: string, requested_json: string, registry_json: string): string;

/**
 * Start a replacement group after unrecoverable state loss (00FD §11).
 *
 * `keyPackagesJson` is a JSON array of base64url serialized KeyPackages, one
 * per member carried over. `baseJson` is the held old-group extremity
 * (`{mls_epoch, commit_id, event_id}`).
 *
 * Returns `{newGroupId, rebootContent, commitContent, commitId, welcome,
 * recipients}`. The one Welcome is shared; build each recipient's to-device
 * content with `dmlsWelcomeContent` once the new Commit's event id is known.
 *
 * # Errors
 * Throws for a malformed argument, a non-member KeyPackage, or an MLS failure.
 */
export function dmlsReboot(group_id_json: string, device_seed_b64: string, reason: string, key_packages_json: string, base_json: string): string;

/**
 * Build the to-device `m.dmls.welcome` content once the Commit's event id is
 * known.
 *
 * Returns `{eventType, content}` for each added recipient, using the shared
 * Welcome bytes and that recipient's `keyPackageId`.
 *
 * # Errors
 * Throws for a malformed id or an empty Welcome.
 */
export function dmlsWelcomeContent(group_id_json: string, commit_event_id: string, commit_id: string, key_package_id: string, welcome_b64: string): string;

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
 * Throws if the event is not valid JSON, lacks an object-valued
 * `device_certificate`, the event sender or certificate's `device_id` /
 * `device_key` does not match the signing arguments, or a seed is malformed.
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
    readonly dmlsApplyCommit: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number, number];
    readonly dmlsCheckReboot: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly dmlsCommit: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly dmlsCreateGroup: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly dmlsDecrypt: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly dmlsEncrypt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number, number, number];
    readonly dmlsExportGroup: (a: number, b: number) => [number, number, number, number];
    readonly dmlsExternalCommit: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number, number];
    readonly dmlsForget: (a: number, b: number) => [number, number];
    readonly dmlsHasGroup: (a: number, b: number) => [number, number, number];
    readonly dmlsImportGroup: (a: number, b: number) => [number, number, number, number];
    readonly dmlsJoinWelcome: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly dmlsKeyPackage: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly dmlsMerge: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number, number];
    readonly dmlsPlanMerge: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly dmlsReboot: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number, number];
    readonly dmlsWelcomeContent: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number, number];
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
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
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
