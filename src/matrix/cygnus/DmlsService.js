/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import * as wasm from "./wasm/cygnus_wasm.js";
import {makeTxnId} from "../common.js";

/** The create-content member that selects DMLS for a Cygnus room. */
export const DMLS_CREATE_KEY = "tk.nutra.cygnus.dmls";
/** The only DMLS transport version this client implements. */
export const DMLS_VERSION = 1;
export const DMLS_CIPHERSUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519";

export const DMLS_EVENT_TYPES = Object.freeze({
    keyPackage: "m.dmls.key_package",
    commit: "m.dmls.commit",
    merge: "m.dmls.merge",
    externalCommit: "m.dmls.external_commit",
    reboot: "m.dmls.reboot",
    welcome: "m.dmls.welcome",
});

const PROTOCOL_EVENT_TYPES = new Set([
    DMLS_EVENT_TYPES.keyPackage,
    DMLS_EVENT_TYPES.commit,
    DMLS_EVENT_TYPES.merge,
    DMLS_EVENT_TYPES.externalCommit,
    DMLS_EVENT_TYPES.reboot,
]);

const STORAGE_KDF_SALT = "tk.nutra.cygnus.dmls.storage.v1";
const LOCK_PREFIX = "cygnus-dmls:";

export class DmlsError extends Error {
    constructor(code, detail = "") {
        super(detail ? `${code}: ${detail}` : code);
        this.code = code;
    }
}

/**
 * Decide whether a room's `m.room.create` content selects DMLS.
 *
 * A Cygnus room without `tk.nutra.cygnus.dmls` keeps the legacy Megolm path. A
 * room advertising an unknown version or ciphersuite is explicitly
 * unsupported, never a reason to fall back to Megolm.
 */
export function dmlsCapability(createContent) {
    if (!createContent || typeof createContent.room_version !== "string" ||
        !createContent.room_version.startsWith("tk.nutra.cygnus.")) {
        return {capable: false, reason: "not_cygnus"};
    }
    const block = createContent[DMLS_CREATE_KEY];
    if (block === undefined) {
        return {capable: false, reason: "absent"};
    }
    if (!block || typeof block !== "object" || Array.isArray(block)) {
        return {capable: false, reason: "malformed"};
    }
    if (block.version !== DMLS_VERSION) {
        return {capable: false, version: block.version, reason: "unsupported_version"};
    }
    if (block.ciphersuite !== undefined && block.ciphersuite !== DMLS_CIPHERSUITE) {
        return {capable: false, version: block.version, reason: "unsupported_ciphersuite"};
    }
    return {capable: true, version: DMLS_VERSION, ciphersuite: DMLS_CIPHERSUITE};
}

/** Find the create event in a sync response and classify the room. */
export function dmlsCapabilityFromRoomResponse(roomResponse) {
    const events = [
        ...(roomResponse?.state?.events || []),
        ...(roomResponse?.timeline?.events || []),
    ];
    const create = events.find(event => event?.type === "m.room.create" && event.state_key === "");
    return create ? dmlsCapability(create.content) : undefined;
}

function decodeBase64Url(value) {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function encodeBase64Url(bytes) {
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The `seq` field of a version-1 group blob:
 * `magic "CYDM" | version u16 | seq u64 | ...`.
 */
export function readBlobSeq(blobB64) {
    const bytes = decodeBase64Url(blobB64);
    if (bytes.length < 14 || bytes[0] !== 0x43 || bytes[1] !== 0x59 || bytes[2] !== 0x44 || bytes[3] !== 0x4d) {
        throw new DmlsError("bad_state", "blob magic");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint16(4) !== 1) {
        throw new DmlsError("unsupported_version", String(view.getUint16(4)));
    }
    return Number(view.getBigUint64(6));
}

function parseWasm(json, what) {
    try {
        return JSON.parse(json);
    } catch (_) {
        throw new DmlsError("internal", `${what} returned invalid JSON`);
    }
}

function contentOf(contentJson) {
    try {
        const value = JSON.parse(contentJson);
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new Error();
        }
        return value;
    } catch (_) {
        throw new DmlsError("bad_argument", "content_json");
    }
}

/**
 * DMLS group lifecycle for one device: capability gating, encrypted blob
 * persistence with a Web Lock and `seq` compare-and-set, single-use KeyPackage
 * secrets, and routing of the protocol events into `cygnus_dmls`.
 *
 * Every wasm instance is process-wide, so this class is the only owner of the
 * group entries it loads. The lock covers import, mutation, export, and the
 * CAS write; nothing is published to Matrix until the write has succeeded.
 */
export class DmlsService {
    /**
     * @param {object} options
     * @param {object} options.storage Hydrogen Storage
     * @param {() => object|undefined} options.getIdentity current CygnusIdentity
     * @param {Crypto} [options.subtleCrypto] WebCrypto with AES-GCM and HKDF
     * @param {(bytes: Uint8Array) => Uint8Array} [options.getRandomValues]
     * @param {(roomId: string, type: string, content: object, txnId: string, log?: object) => Promise<string>} options.sendEvent
     * @param {(type: string, payload: object, txnId: string, log?: object) => Promise<void>} [options.sendToDevice]
     * @param {(roomId: string, event: object) => Promise<string|undefined>} [options.getRegistryJson]
     * @param {() => number} [options.now]
     */
    constructor({
        storage, getIdentity, subtleCrypto, getRandomValues, sendEvent, sendToDevice,
        getRegistryJson, now = () => Date.now(),
    }) {
        this._storage = storage;
        this._getIdentity = getIdentity;
        this._subtle = subtleCrypto;
        this._getRandomValues = getRandomValues || (bytes => crypto.getRandomValues(bytes));
        this._sendEvent = sendEvent;
        this._sendToDevice = sendToDevice;
        this._getRegistryJson = getRegistryJson;
        this._now = now;
        this._keys = new Map();
        this._loadedSeq = new Map();
        this._chains = new Map();
        this._queues = new Map();
        this._locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    }

    /** True when a room's create content selects the supported DMLS version. */
    static capability(createContent) {
        return dmlsCapability(createContent);
    }

    /** True when a sync response's create event selects DMLS. */
    static capabilityFromRoomResponse(roomResponse) {
        return dmlsCapabilityFromRoomResponse(roomResponse);
    }

    // ---------- identity and storage crypto ----------

    _identity() {
        const identity = this._getIdentity();
        if (!identity) {
            throw new DmlsError("bad_state", "no Cygnus identity");
        }
        if (identity.isRetired || identity.isHandoffPending) {
            throw new DmlsError("bad_state", "identity cannot sign");
        }
        if (!identity.deviceSeed) {
            throw new DmlsError("bad_state", "identity has no device seed");
        }
        return identity;
    }

    _identityJson() {
        const identity = this._identity();
        return JSON.stringify({deviceId: identity.deviceId, principal: identity.principal});
    }

    _seed() {
        return this._identity().deviceSeed;
    }

    async _storageKey(purpose) {
        if (!this._subtle) {
            throw new DmlsError("bad_state", "WebCrypto is required to persist DMLS state");
        }
        let key = this._keys.get(purpose);
        if (!key) {
            const encoder = new TextEncoder();
            key = (async () => {
                const material = await this._subtle.importKey(
                    "raw", decodeBase64Url(this._seed()), "HKDF", false, ["deriveKey"]);
                return this._subtle.deriveKey({
                    name: "HKDF",
                    hash: "SHA-256",
                    salt: encoder.encode(STORAGE_KDF_SALT),
                    info: encoder.encode(purpose),
                }, material, {name: "AES-GCM", length: 256}, false, ["encrypt", "decrypt"]);
            })();
            this._keys.set(purpose, key);
        }
        try {
            return await key;
        } catch (err) {
            this._keys.delete(purpose);
            throw err;
        }
    }

    async _seal(purpose, plaintext) {
        const key = await this._storageKey(purpose);
        const iv = this._getRandomValues(new Uint8Array(12));
        const ciphertext = await this._subtle.encrypt(
            {name: "AES-GCM", iv}, key, new TextEncoder().encode(plaintext));
        return {v: 1, iv: encodeBase64Url(iv), ct: encodeBase64Url(new Uint8Array(ciphertext))};
    }

    async _open(purpose, envelope) {
        if (!envelope || envelope.v !== 1 || typeof envelope.iv !== "string" || typeof envelope.ct !== "string") {
            throw new DmlsError("bad_state", "invalid encrypted DMLS value");
        }
        const key = await this._storageKey(purpose);
        try {
            const plaintext = await this._subtle.decrypt(
                {name: "AES-GCM", iv: decodeBase64Url(envelope.iv)}, key, decodeBase64Url(envelope.ct));
            return new TextDecoder().decode(plaintext);
        } catch (_) {
            throw new DmlsError("bad_state", "could not decrypt DMLS state");
        }
    }

    // ---------- locking and CAS ----------

    async _withLock(name, fn) {
        const key = LOCK_PREFIX + name;
        if (this._locks?.request) {
            return this._locks.request(key, fn);
        }
        // Single-tab fallback; a browser without Web Locks must not run two
        // writers in one tab. Secondary tabs are refused by the caller.
        const previous = this._chains.get(key) || Promise.resolve();
        const run = previous.then(fn, fn);
        const tail = run.catch(() => {});
        this._chains.set(key, tail);
        try {
            return await run;
        } finally {
            if (this._chains.get(key) === tail) {
                this._chains.delete(key);
            }
        }
    }

    async _read(groupId) {
        const txn = await this._storage.readTxn([this._storage.storeNames.dmlsGroups]);
        return txn.dmlsGroups.get(groupId);
    }

    async _activeGroup(roomId) {
        const txn = await this._storage.readTxn([this._storage.storeNames.dmlsGroups]);
        return txn.dmlsGroups.getActiveForRoom(roomId);
    }

    async _loadLocked(groupId, record) {
        if (!record) {
            if (wasm.dmlsHasGroup(groupId)) {
                wasm.dmlsForget(groupId);
            }
            this._loadedSeq.delete(groupId);
            return;
        }
        if (this._loadedSeq.get(groupId) === record.seq && wasm.dmlsHasGroup(groupId)) {
            return;
        }
        if (wasm.dmlsHasGroup(groupId)) {
            wasm.dmlsForget(groupId);
        }
        const plaintext = await this._open("group", record.blob);
        const imported = parseWasm(wasm.dmlsImportGroup(plaintext), "import");
        if (imported.groupId !== groupId) {
            throw new DmlsError("bad_state", "blob names another group");
        }
        if (imported.seq !== record.seq) {
            // a torn or tampered write; never trust the record's CAS value
            throw new DmlsError("bad_state", "blob seq does not match its record");
        }
        this._loadedSeq.set(groupId, imported.seq);
    }

    async _writeCas(groupId, roomId, expectedSeq, plaintext, seq) {
        const blob = await this._seal("group", plaintext);
        const txn = await this._storage.readWriteTxn([this._storage.storeNames.dmlsGroups]);
        const current = await txn.dmlsGroups.get(groupId);
        if ((current?.seq) !== expectedSeq) {
            txn.abort();
            throw new DmlsError("stale_state", groupId);
        }
        txn.dmlsGroups.set({groupId, roomId, seq, updatedTs: this._now(), blob});
        await txn.complete();
        this._loadedSeq.set(groupId, seq);
    }

    /**
     * Import the persisted state, run one wasm mutation, then export and
     * CAS-write it. A `stale_state` conflict discards the in-memory entry,
     * re-imports, and retries once.
     */
    async _mutateLocked(groupId, roomId, fn) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const record = await this._read(groupId);
            await this._loadLocked(groupId, record);
            const result = parseWasm(await fn(), "mutation");
            const plaintext = wasm.dmlsExportGroup(groupId);
            const seq = readBlobSeq(plaintext);
            if (record && seq === record.seq) {
                // rejected/deferred paths are documented to leave state alone
                return result;
            }
            try {
                await this._writeCas(groupId, roomId, record?.seq, plaintext, seq);
                return result;
            } catch (err) {
                if (err.code !== "stale_state" || attempt === 1) {
                    throw err;
                }
            }
        }
        throw new DmlsError("stale_state", groupId);
    }

    /** Run a read-only wasm call against the persisted state under the lock. */
    async _readLocked(groupId, fn) {
        return this._withLock(groupId, async () => {
            const record = await this._read(groupId);
            await this._loadLocked(groupId, record);
            return parseWasm(await fn(), "read");
        });
    }

    async _recordForGroup(groupId) {
        const record = await this._read(groupId);
        if (!record) {
            throw new DmlsError("unknown_group", groupId);
        }
        return record;
    }

    // ---------- lifecycle ----------

    /**
     * Empty the wasm entry for a room's group and delete its blob. Use when
     * leaving a room or after unrecoverable local state loss.
     */
    async forgetRoom(roomId) {
        const txn = await this._storage.readWriteTxn([
            this._storage.storeNames.dmlsGroups,
            this._storage.storeNames.dmlsKeyPackages,
        ]);
        const groups = await txn.dmlsGroups.getAllForRoom(roomId);
        for (const group of groups) {
            wasm.dmlsForget(group.groupId);
            this._loadedSeq.delete(group.groupId);
            txn.dmlsGroups.remove(group.groupId);
        }
        await txn.dmlsKeyPackages.removeForRoom(roomId);
        await txn.complete();
    }

    /**
     * Create the epoch-0 group for a room and persist it. Nothing is
     * published; the first event is the epoch-1 Commit from `sendCommit`.
     */
    async createGroup(roomId) {
        return this._withLock(`room:${roomId}`, async () => {
            const existing = await this._activeGroup(roomId);
            if (existing) {
                return {groupId: existing.groupId};
            }
            const out = parseWasm(
                wasm.dmlsCreateGroup(this._identityJson(), this._seed(), roomId), "create");
            const plaintext = wasm.dmlsExportGroup(out.groupId);
            await this._writeCas(out.groupId, roomId, undefined, plaintext, readBlobSeq(plaintext));
            return out;
        });
    }

    /** The room's active group record, or undefined before the first create. */
    activeGroup(roomId) {
        return this._activeGroup(roomId);
    }

    /**
     * Create a single-use KeyPackage and persist its secret before returning.
     * The caller may now publish `content`; a Welcome can arrive immediately.
     */
    async keyPackage(roomId) {
        const out = parseWasm(wasm.dmlsKeyPackage(this._identityJson(), this._seed()), "key_package");
        const secret = await this._seal("key-package", out.secretsB64);
        const txn = await this._storage.readWriteTxn([this._storage.storeNames.dmlsKeyPackages]);
        txn.dmlsKeyPackages.set({
            keyPackageId: out.keyPackageId,
            roomId,
            secret,
            expiresTs: typeof out.content?.expires_ts === "number" ? out.content.expires_ts : undefined,
        });
        await txn.complete();
        return out;
    }

    /** Store the KeyPackage secret, then publish the event. */
    async publishKeyPackage(roomId, log) {
        const out = await this.keyPackage(roomId);
        const eventId = await this._sendEvent(roomId, out.eventType, out.content, makeTxnId(), log);
        return {...out, eventId};
    }

    /** Drop the stored secret after a successful join or on expiry. */
    async deleteKeyPackageSecret(keyPackageId) {
        const txn = await this._storage.readWriteTxn([this._storage.storeNames.dmlsKeyPackages]);
        txn.dmlsKeyPackages.remove(keyPackageId);
        await txn.complete();
    }

    /**
     * Join from a verified `m.dmls.welcome` content. The group id comes from
     * the content, so a reboot replacement group joins like any other.
     */
    async joinWelcome(welcomeContentJson) {
        const content = contentOf(welcomeContentJson);
        if (typeof content.group_id !== "string" || typeof content.key_package_id !== "string") {
            throw new DmlsError("bad_argument", "welcome content");
        }
        const txn = await this._storage.readTxn([this._storage.storeNames.dmlsKeyPackages]);
        const stored = await txn.dmlsKeyPackages.get(content.key_package_id);
        if (!stored) {
            return {status: "wrong_key_package"};
        }
        const secret = await this._open("key-package", stored.secret);
        const result = await this._withLock(content.group_id, () => this._mutateLocked(
            content.group_id, stored.roomId,
            () => wasm.dmlsJoinWelcome(this._identityJson(), this._seed(), welcomeContentJson, secret)));
        if (result.status === "applied") {
            await this.deleteKeyPackageSecret(content.key_package_id);
        }
        return result;
    }

    // ---------- sending ----------

    async _groupForSend(roomId) {
        const record = await this._activeGroup(roomId);
        if (record) {
            return record;
        }
        const created = await this.createGroup(roomId);
        return this._recordForGroup(created.groupId);
    }

    async _sendWelcomes(groupId, eventId, out, log) {
        if (!out.welcome || !Array.isArray(out.recipients) || !out.recipients.length) {
            return;
        }
        if (!this._sendToDevice) {
            throw new DmlsError("internal", "no to-device sender for the Welcome");
        }
        for (const recipient of out.recipients) {
            const content = parseWasm(wasm.dmlsWelcomeContent(
                groupId, eventId, out.commitId, recipient.keyPackageId, out.welcome), "welcome_content");
            const toDevice = recipient.toDevice || {};
            const payload = {messages: {[toDevice.principal]: {[toDevice.deviceId]: content}}};
            await this._sendToDevice(DMLS_EVENT_TYPES.welcome, payload, makeTxnId(), log);
        }
    }

    /**
     * Send one membership Commit. `baseJson` is the held base extremity and
     * may be omitted only on the genesis state. The Welcome, if any, is sent
     * after the Commit's event id is known.
     */
    async sendCommit(roomId, opsJson, baseJson, log) {
        const group = await this._groupForSend(roomId);
        const out = await this._withLock(group.groupId, () => this._mutateLocked(
            group.groupId, roomId,
            () => wasm.dmlsCommit(group.groupId, this._seed(), opsJson, baseJson)));
        const eventId = await this._sendEvent(roomId, out.eventType, out.content, makeTxnId(), log);
        await this._sendWelcomes(group.groupId, eventId, out, log);
        return {...out, eventId};
    }

    /**
     * Plan and send an `m.dmls.merge`. `registryJson` is the per-call device
     * root registry; it is never cached here. `keyPackagesJson` is the optional
     * JSON array of base64url KeyPackages for the members the plan Adds; a plan
     * that adds without one comes back `rejected` / `missing_key_package`.
     */
    async sendMerge(roomId, requestedJson, registryJson, keyPackagesJson, log) {
        const group = await this._groupForSend(roomId);
        const out = await this._withLock(group.groupId, () => this._mutateLocked(
            group.groupId, roomId,
            () => wasm.dmlsMerge(
                group.groupId, this._seed(), requestedJson, registryJson, keyPackagesJson)));
        if (out.status !== "merged") {
            return out;
        }
        const eventId = await this._sendEvent(roomId, out.eventType, out.content, makeTxnId(), log);
        await this._sendWelcomes(group.groupId, eventId, out, log);
        return {...out, eventId};
    }

    /**
     * Join via an external Commit against `targetJson`, whose GroupInfo is in
     * `sourceContentJson`. Persists the new state before publishing.
     */
    async sendExternalCommit(roomId, targetJson, sourceContentJson, log) {
        const out = parseWasm(wasm.dmlsExternalCommit(
            this._identityJson(), this._seed(), roomId, targetJson, sourceContentJson), "external_commit");
        const plaintext = wasm.dmlsExportGroup(out.groupId);
        await this._withLock(out.groupId, () => this._writeCas(
            out.groupId, roomId, undefined, plaintext, readBlobSeq(plaintext)));
        const eventId = await this._sendEvent(roomId, out.eventType, out.content, makeTxnId(), log);
        return {...out, eventId};
    }

    /**
     * Start a replacement group after state loss: publish the reboot, the new
     * group's epoch-0 Commit, and the per-recipient Welcomes.
     */
    async sendReboot(roomId, reason, keyPackagesJson, baseJson, log) {
        const old = await this._groupForSend(roomId);
        const {reboot, commit, newGroupId} = await this._withLock(old.groupId, async () => {
            const record = await this._read(old.groupId);
            await this._loadLocked(old.groupId, record);
            const reboot = parseWasm(wasm.dmlsReboot(
                old.groupId, this._seed(), reason, keyPackagesJson, baseJson), "reboot");
            const plaintext = wasm.dmlsExportGroup(reboot.newGroupId);
            await this._writeCas(
                reboot.newGroupId, roomId, undefined, plaintext, readBlobSeq(plaintext));
            return {reboot, commit: reboot, newGroupId: reboot.newGroupId};
        });
        const rebootEventId = await this._sendEvent(
            roomId, DMLS_EVENT_TYPES.reboot, reboot.rebootContent, makeTxnId(), log);
        const commitEventId = await this._sendEvent(
            roomId, DMLS_EVENT_TYPES.commit, commit.commitContent, makeTxnId(), log);
        await this._sendWelcomes(newGroupId, commitEventId, {
            welcome: commit.welcome,
            recipients: commit.recipients,
            commitId: commit.commitId,
        }, log);
        return {...commit, rebootEventId, commitEventId};
    }

    // ---------- receiving ----------

    /**
     * Route one room event. Returns the protocol result, or undefined for a
     * type this service does not own.
     */
    async handleRoomEvent(roomId, event) {
        if (!event || !PROTOCOL_EVENT_TYPES.has(event.type)) {
            return undefined;
        }
        const contentJson = JSON.stringify(event.content ?? {});
        const content = contentOf(contentJson);
        const ctxJson = JSON.stringify(await this._contextForEvent(roomId, event));
        switch (event.type) {
            case DMLS_EVENT_TYPES.commit:
            case DMLS_EVENT_TYPES.externalCommit:
                return this.applyCommit(
                    roomId, event.type, ctxJson, content, undefined);
            case DMLS_EVENT_TYPES.merge: {
                const registryJson = await this._getRegistryJson?.(roomId, event);
                if (!registryJson) {
                    return {status: "deferred", reason: "registry_unavailable"};
                }
                return this.applyCommit(roomId, event.type, ctxJson, content, registryJson);
            }
            case DMLS_EVENT_TYPES.reboot:
                return this.checkReboot(content, ctxJson);
            default:
                return {status: "ignored", reason: event.type};
        }
    }

    /** Apply a received `m.dmls.commit`, `m.dmls.merge`, or external Commit. */
    async applyCommit(roomId, eventType, ctxJson, content, registryJson) {
        const groupId = content.group_id;
        if (typeof groupId !== "string") {
            throw new DmlsError("bad_argument", "group_id");
        }
        return this._withLock(groupId, () => this._mutateLocked(
            groupId, roomId,
            () => wasm.dmlsApplyCommit(
                groupId, eventType, JSON.stringify(content), ctxJson, registryJson)));
    }

    /**
     * Authorize a received reboot against the held old group without changing
     * state. A member that lost the base defers rather than guessing.
     */
    async checkReboot(content, ctxJson) {
        const groupId = content.old_group_id;
        if (typeof groupId !== "string") {
            throw new DmlsError("bad_argument", "old_group_id");
        }
        const record = await this._read(groupId);
        if (!record) {
            return {status: "deferred", reason: "missing_base_state"};
        }
        return this._readLocked(groupId, () =>
            wasm.dmlsCheckReboot(groupId, JSON.stringify(content), ctxJson));
    }

    /** Handle a to-device `m.dmls.welcome` event. */
    async handleToDevice(event) {
        if (event?.type !== DMLS_EVENT_TYPES.welcome) {
            return undefined;
        }
        return this.joinWelcome(JSON.stringify(event.content ?? {}));
    }

    /**
     * Process room events after a sync write, in order per room. Errors are
     * logged and do not stop later events; the next sync retries the event.
     */
    enqueueRoomEvents(roomId, events, log) {
        const protocolEvents = events.filter(event => PROTOCOL_EVENT_TYPES.has(event?.type));
        if (!protocolEvents.length) {
            return Promise.resolve([]);
        }
        const previous = this._queues.get(roomId) || Promise.resolve();
        const run = previous.then(async () => {
            const results = [];
            for (const event of protocolEvents) {
                try {
                    const result = await this.handleRoomEvent(roomId, event);
                    if (result !== undefined) {
                        results.push({eventId: event.event_id, result});
                    }
                } catch (err) {
                    log?.catch?.(err);
                }
            }
            return results;
        });
        this._queues.set(roomId, run.catch(() => {}));
        return run;
    }

    async _contextForEvent(roomId, event) {
        const deviceId = event.device_certificate?.device_id ??
            event.content?.joiner?.device_id;
        if (!deviceId) {
            throw new DmlsError("bad_argument", "event has no device certificate");
        }
        return {
            senderMember: `${event.sender}:${deviceId}`,
            ancestors: await this._ancestors(roomId, event),
        };
    }

    /** Collect the event's ancestors from the persisted timeline, newest first. */
    async _ancestors(roomId, event) {
        const txn = await this._storage.readTxn([this._storage.storeNames.timelineEvents]);
        const seen = new Set();
        const queue = [...(event.prev_events || [])];
        const ancestors = [];
        while (queue.length && ancestors.length < 512) {
            const eventId = queue.shift();
            if (seen.has(eventId)) {
                continue;
            }
            seen.add(eventId);
            ancestors.push(eventId);
            const entry = await txn.timelineEvents.getByEventId(roomId, eventId);
            if (entry?.event?.prev_events) {
                queue.push(...entry.event.prev_events);
            }
        }
        return ancestors;
    }

}
