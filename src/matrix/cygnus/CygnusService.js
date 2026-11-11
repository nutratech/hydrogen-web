/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {ObservableValue} from "../../observable/value";
import {CygnusCrypto} from "./CygnusCrypto.js";
import {CygnusIdentity} from "./CygnusIdentity.js";
import {CygnusEventSigner} from "./CygnusEventSigner.js";
import {CygnusRooms} from "./CygnusRooms.js";
import {isCygnusRoomVersion} from "./constants.js";

/** The `unstable_features` flag a homeserver advertises for MSC00FC. */
export const CYGNUS_UNSTABLE_FEATURE = "tk.nutra.cygnus";

/** Matrix secrets are unpadded standard base64; Cygnus seeds are unpadded base64url. */
function base64ToBase64Url(value) {
    return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBase64(value) {
    return value.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
}

const MOVE_BUNDLE_AAD = new TextEncoder().encode("tk.nutra.cygnus.move.v1");
const MOVE_BUNDLE_ITERATIONS = 250000;

function encodeBytes(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBytes(value) {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function deriveMoveBundleKey(passphrase, salt, subtle) {
    if (typeof passphrase !== "string" || passphrase.length < 12) {
        throw new Error("move handoff passphrase must be at least 12 characters");
    }
    if (!subtle) throw new Error("WebCrypto is required to encrypt the Cygnus move handoff");
    const material = await subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
    return subtle.deriveKey({name: "PBKDF2", hash: "SHA-256", salt, iterations: MOVE_BUNDLE_ITERATIONS}, material,
        {name: "AES-GCM", length: 256}, false, ["encrypt", "decrypt"]);
}

async function encryptMoveBundle(bundle, passphrase, subtle, getRandomValues) {
    const salt = getRandomValues(new Uint8Array(16));
    const iv = getRandomValues(new Uint8Array(12));
    const key = await deriveMoveBundleKey(passphrase, salt, subtle);
    const ciphertext = await subtle.encrypt(
        {name: "AES-GCM", iv, additionalData: MOVE_BUNDLE_AAD}, key, new TextEncoder().encode(JSON.stringify(bundle)),
    );
    return JSON.stringify({version: 1, kdf: "PBKDF2-SHA256", iterations: MOVE_BUNDLE_ITERATIONS,
        cipher: "AES-256-GCM", salt: encodeBytes(salt), iv: encodeBytes(iv), ciphertext: encodeBytes(new Uint8Array(ciphertext))});
}

async function decryptMoveBundle(encrypted, passphrase, subtle) {
    let envelope;
    try { envelope = JSON.parse(encrypted); } catch (_) { throw new Error("invalid encrypted Cygnus move bundle"); }
    if (envelope?.version !== 1 || envelope.kdf !== "PBKDF2-SHA256" ||
        envelope.iterations !== MOVE_BUNDLE_ITERATIONS || envelope.cipher !== "AES-256-GCM" ||
        typeof envelope.salt !== "string" || typeof envelope.iv !== "string" || typeof envelope.ciphertext !== "string") {
        throw new Error("unsupported encrypted Cygnus move bundle");
    }
    try {
        const salt = decodeBytes(envelope.salt);
        const key = await deriveMoveBundleKey(passphrase, salt, subtle);
        const plaintext = await subtle.decrypt(
            {name: "AES-GCM", iv: decodeBytes(envelope.iv), additionalData: MOVE_BUNDLE_AAD},
            key,
            decodeBytes(envelope.ciphertext),
        );
        return JSON.parse(new TextDecoder().decode(plaintext));
    } catch (_) {
        throw new Error("could not decrypt the Cygnus move bundle; check the passphrase and bundle");
    }
}

/**
 * Session-level entry point for MSC00FC: whether the homeserver supports it,
 * this account's principal (if any), and the identity and room flows.
 *
 * Nothing loads unless the Cygnus feature flag is on, so ordinary sessions
 * never fetch the wasm module.
 */
export class CygnusService {
    constructor({storage, hsApi, secretFetcher, userId, deviceId, getRandomValues, subtleCrypto, wasmSource}) {
        this._storage = storage;
        this._hsApi = hsApi;
        this._secretFetcher = secretFetcher;
        this._userId = userId;
        this._deviceId = deviceId;
        this._wasmSource = wasmSource;
        this._getRandomValues = getRandomValues;
        this._subtleCrypto = subtleCrypto || (typeof window !== "undefined" ? window.crypto?.subtle : undefined);
        this._crypto = new CygnusCrypto(getRandomValues);
        this._isSupported = false;
        /** @type {ObservableValue<CygnusIdentity | undefined>} */
        this.identity = new ObservableValue(undefined);
        this._loading = undefined;
    }

    /** True once `load` found the homeserver advertising MSC00FC. */
    get isSupported() {
        return this._isSupported;
    }

    load(log) {
        if (!this._loading) {
            this._loading = this._load(log).catch(err => {
                this._loading = undefined;
                throw err;
            });
        }
        return this._loading;
    }

    async _load(log) {
        const txn = await this._storage.readTxn([this._storage.storeNames.session]);
        const versions = await txn.session.get("serverVersions");
        this._isSupported = versions?.unstable_features?.[CYGNUS_UNSTABLE_FEATURE] === true;
        log?.set("supported", this._isSupported);
        await this._crypto.load(this._wasmSource);
        if (!this.identity.get()) {
            this.identity.set(await CygnusIdentity.load(this._deps()));
        }
    }

    /**
     * Read the stored identity record only (no wasm, no network), so a session knows its
     * principal before the first sync recognises principal-keyed invites and events.
     */
    async loadStoredIdentity() {
        if (!this.identity.get()) {
            const identity = await CygnusIdentity.load(this._deps());
            if (identity) {
                this.identity.set(identity);
            }
        }
    }

    /**
     * Create this account's principal. The master and self-signing keys are
     * the account's cross-signing keys, so secret storage must be unlocked (or
     * the keys shared from another device) first.
     */
    async createIdentity(log) {
        await this.load(log);
        this._requireSupport();
        if (this.identity.get()) {
            throw new Error("this session already has a Cygnus identity");
        }
        if (!this._secretFetcher.hasSecretStorage) {
            throw new Error("unlock secret storage before creating a Cygnus identity");
        }
        const [master, selfSigning] = await Promise.all([
            this._secretFetcher.getSecret("m.cross_signing.master"),
            this._secretFetcher.getSecret("m.cross_signing.self_signing"),
        ]);
        if (!master || !selfSigning) {
            throw new Error("Set up cross-signing and unlock secret storage first: the principal's master key is your cross-signing master key.");
        }
        let identity;
        try {
            identity = await CygnusIdentity.create({
                ...this._deps(),
                masterSeed: base64ToBase64Url(master),
                selfSigningSeed: base64ToBase64Url(selfSigning),
                deviceId: this._deviceId,
                displayUserId: this._userId,
                log,
            });
        } catch (err) {
            // creation persists the identity before backing up its rotation key; adopt it
            // rather than let a retry mint a second principal over it
            const persisted = await CygnusIdentity.load(this._deps()).catch(() => undefined);
            if (persisted) {
                this.identity.set(persisted);
            }
            throw err;
        }
        this.identity.set(identity);
        return identity;
    }

    async rotate(log) {
        const identity = this._requireIdentity();
        await identity.rotate({log});
        this.identity.set(identity);
    }

    /** Permanently revoke another Matrix device and publish the list with a chain advancement. */
    async revokeDevice(deviceId, log) {
        const identity = this._requireIdentity();
        if (deviceId === identity.deviceId) {
            throw new Error("another active Cygnus signer must revoke this device");
        }
        if (identity.pendingMove) {
            throw new Error("finish the pending Cygnus move before revoking a device");
        }
        await identity.revokeDevice(deviceId);
        await identity.rotate({log});
        this.identity.set(identity);
    }

    createRoom(options, log) {
        return this._rooms().createRoom({...options, log});
    }

    joinRoom(roomId, log, via) {
        return this._rooms().joinRoom(roomId, {log, via});
    }

    leaveRoom(roomId, log) {
        return this._rooms().leaveRoom(roomId, {log});
    }

    /** Sign and retire this source device, retaining only an encrypted bundle for retry. */
    async prepareMoveHandoff({custodian, displayUserId, roomIds = [], passphrase, log} = {}) {
        const identity = this.identity.get();
        if (!identity) throw new Error("no source Cygnus identity is available to move");
        if (identity.isRetired) {
            const encrypted = identity.pendingMoveBundle;
            if (!encrypted) throw new Error("the retired source has no recoverable move bundle");
            await this._secretFetcher.deleteSecret("m.principal.rotation_key", log);
            return encrypted;
        }
        if (identity.hasPendingRotation) await identity.rotate({log});
        const allRooms = [...new Set([...(await this._joinedCygnusRoomIds()), ...roomIds])];
        const [masterSeed, selfSigningSeed, userSigningSeed] = await Promise.all([
            this._secretFetcher.readSecretStorage("m.cross_signing.master"),
            this._secretFetcher.readSecretStorage("m.cross_signing.self_signing"),
            this._secretFetcher.readSecretStorage("m.cross_signing.user_signing"),
        ]);
        if (!masterSeed || !selfSigningSeed || this._crypto.publicKey(base64ToBase64Url(masterSeed)) !== identity.masterKey) {
            throw new Error("source secret storage does not contain the cross-signing keys for this identity");
        }
        if (!identity.pendingMove && !identity.revokedDeviceIds.includes(identity.deviceId)) {
            await identity.revokeDevice(identity.deviceId);
        }
        // Stop ordinary event signing before preparing or encrypting the
        // handoff. A failure here can resume the exact same signed move link.
        await identity.beginMoveHandoff();
        let pendingMove;
        try {
            pendingMove = await identity.prepareMove({custodian, displayUserId, roomIds: allRooms});
        } catch (err) {
            // no signed move link exists yet: let this device sign again
            await identity.cancelMoveHandoff().catch(() => {});
            throw err;
        }
        if (pendingMove.custodian !== custodian || pendingMove.displayUserId !== displayUserId) {
            throw new Error("pending Cygnus move targets a different destination");
        }
        const record = identity.exportMoveRecord();
        delete record.rotationSeed; // the spent key never leaves the source device
        record.revokedDeviceIds = [...new Set([...record.revokedDeviceIds, identity.deviceId])];
        const bundle = {
            version: 1,
            record,
            links: [...identity.links, pendingMove.link],
            rotationKey: pendingMove.nextRotationSeed,
            masterSeed,
            selfSigningSeed,
            userSigningSeed, // lets the destination publish all three keys
            sourceDeviceId: identity.deviceId,
            revokedDeviceIds: [...new Set([...identity.revokedDeviceIds, identity.deviceId])],
            roomIds: [...new Set([...allRooms, ...identity.pendingRebindRoomIds])],
            via: pendingMove.rebindVia,
        };
        const encrypted = await encryptMoveBundle(bundle, passphrase, this._subtleCrypto, bytes => {
            if (this._getRandomValues) return this._getRandomValues(bytes);
            const seed = decodeBytes(this._crypto.generateSeed());
            bytes.set(seed.subarray(0, bytes.length));
            return bytes;
        });
        await identity.retireWithMoveBundle(encrypted);
        await this._secretFetcher.deleteSecret("m.principal.rotation_key", log);
        this.identity.set(identity);
        return encrypted;
    }

    /**
     * Import a source-signed, passphrase-encrypted handoff on this destination session.
     * `publishCrossSigningKeys({masterSeed, selfSigningSeed, userSigningSeed})`, when
     * given, publishes the carried keys on the destination account first (it needs the
     * account password, which only the caller has); it must be idempotent.
     */
    async importMoveHandoff(encryptedBundle, passphrase, {sourceService, custodian, publishCrossSigningKeys, log} = {}) {
        this._requireSupport();
        const bundle = await decryptMoveBundle(encryptedBundle, passphrase, this._subtleCrypto);
        this._validateMoveBundle(bundle, custodian);
        if (publishCrossSigningKeys) {
            await publishCrossSigningKeys({
                masterSeed: bundle.masterSeed,
                selfSigningSeed: bundle.selfSigningSeed,
                userSigningSeed: bundle.userSigningSeed,
            });
        }
        await this._validateDestinationCrossSigningKeys(bundle, log);
        if (!this._secretFetcher?.hasSecretStorage) {
            throw new Error("unlock destination secret storage before moving the Cygnus identity");
        }
        let identity = this.identity.get();
        if (!identity) {
            const record = {
                ...bundle.record,
                // the bundle's room list also carries rooms still waiting to be rebound
                pendingMove: {...bundle.record.pendingMove, roomIds: bundle.roomIds},
                links: bundle.links.slice(0, -1),
                rotationSeed: bundle.rotationKey,
                deviceId: this._deviceId,
                deviceSeed: undefined,
                deviceCertificate: undefined,
                handoffPending: true,
                revokedDeviceIds: bundle.revokedDeviceIds,
                pendingRevocationImport: bundle.sourceDeviceId,
            };
            identity = await CygnusIdentity.importMoveRecord(record, {
                storage: this._storage,
                hsApi: this._hsApi,
                crypto: this._crypto,
            });
            this.identity.set(identity);
        } else if (identity.principal !== bundle.record.principal || !identity.isHandoffPending) {
            throw new Error("destination session already has a different or active Cygnus identity");
        }

        const storedRotationKey = await this._secretFetcher.readSecretStorage("m.principal.rotation_key");
        const storedSeed = storedRotationKey ? base64ToBase64Url(storedRotationKey) : undefined;
        if (storedSeed && storedSeed !== bundle.rotationKey) {
            throw new Error("destination secret storage already contains a different rotation key");
        }
        await this._secretFetcher.writeSecret("m.principal.rotation_key", base64UrlToBase64(bundle.rotationKey), log);
        if (identity.pendingMove || identity.pendingRevocationImport) {
            const response = await this._hsApi.cygnusImportPrincipal(
                bundle.links, bundle.revokedDeviceIds, {log},
            ).response();
            await identity.completeMove(response.links, response.principal, this._hsApi);
            if (identity.pendingRevocationImport) await identity.clearPendingRevocationImport();
        }
        if (!identity.deviceCertificate) {
            await identity.certifyDevice({
                deviceId: this._deviceId,
                masterSeed: base64ToBase64Url(bundle.masterSeed),
                selfSigningSeed: base64ToBase64Url(bundle.selfSigningSeed),
            });
        }
        await this._finishMoveHandoff(identity, sourceService, log, bundle);
        return this.resumeMoveRebinds(log);
    }

    async acknowledgeMoveHandoff() {
        const identity = this.identity.get();
        if (identity?.isRetired) {
            await identity.clearMoveBundle();
            this.identity.set(identity);
        }
    }

    async _joinedCygnusRoomIds() {
        const roomSummaryStore = this._storage.storeNames.roomSummary;
        if (!roomSummaryStore) return [];
        const txn = await this._storage.readTxn([roomSummaryStore]);
        const summaries = await txn.roomSummary.getAll();
        return summaries
            .filter(summary => summary.membership === "join" && isCygnusRoomVersion(summary.roomVersion))
            .map(summary => summary.roomId);
    }

    async resumeMoveRebinds(log) {
        const identity = this._requireIdentity();
        const rooms = new CygnusRooms({identity, signer: this._signer(identity)});
        let failure;
        // one room that cannot rejoin must not keep the others from rebinding
        for (const roomId of [...identity.pendingRebindRoomIds]) {
            try {
                await rooms.rebindRoom(roomId, {log, via: identity.pendingRebindVia});
                await identity.markRoomRebound(roomId);
            } catch (err) {
                if (!failure) failure = err;
            }
        }
        this.identity.set(identity);
        if (failure) throw failure;
    }

    async _finishMoveHandoff(identity, sourceService, log, bundle) {
        const storedRotationKey = await this._secretFetcher.readSecretStorage("m.principal.rotation_key");
        const expectedRotationKey = base64ToBase64Url(identity.rotationSeed);
        if (storedRotationKey && base64ToBase64Url(storedRotationKey) !== expectedRotationKey) {
            throw new Error("destination secret storage contains a different rotation key");
        }
        await this._secretFetcher.writeSecret("m.cross_signing.master", bundle.masterSeed, log);
        await this._secretFetcher.writeSecret("m.cross_signing.self_signing", bundle.selfSigningSeed, log);
        await this._secretFetcher.writeSecret("m.principal.rotation_key", base64UrlToBase64(identity.rotationSeed), log);
        identity.setSecretFetcher(this._secretFetcher);
        if (identity.isHandoffPending) await identity.finishMoveHandoff();
        // only now is the destination committed; the source's recovery bundle can go
        await sourceService?.acknowledgeMoveHandoff();
        this.identity.set(identity);
    }

    _validateMoveBundle(bundle, custodian) {
        if (bundle?.version !== 1 || !bundle.record || !bundle.sourceDeviceId ||
            !Array.isArray(bundle.links) || !bundle.links.length ||
            typeof bundle.rotationKey !== "string" ||
            typeof bundle.masterSeed !== "string" ||
            typeof bundle.selfSigningSeed !== "string" ||
            !Array.isArray(bundle.revokedDeviceIds) ||
            !Array.isArray(bundle.roomIds) ||
            !bundle.record.principal || !bundle.record.custodian || !bundle.record.displayUserId ||
            !bundle.record.masterKey || !bundle.record.deviceId) {
            throw new Error("unsupported or incomplete Cygnus move bundle");
        }
        const verified = this._crypto.verifyChain(bundle.links);
        if (!verified.ok || verified.principal !== bundle.record.principal) {
            throw new Error(`source identity chain is invalid: ${verified.error ?? verified.principal}`);
        }
        const tip = this._crypto.parseLink(bundle.links[bundle.links.length - 1]);
        const priorLinks = bundle.links.slice(0, -1);
        if (bundle.sourceDeviceId !== bundle.record.deviceId ||
            JSON.stringify(priorLinks) !== JSON.stringify(bundle.record.links) ||
            tip.custodian !== custodian ||
            tip.display_user_id !== this._userId ||
            tip.master_key !== bundle.record.masterKey ||
            !bundle.revokedDeviceIds.includes(bundle.sourceDeviceId) ||
            bundle.record.pendingMove?.link !== bundle.links[bundle.links.length - 1] ||
            bundle.record.pendingMove?.custodian !== custodian ||
            bundle.record.pendingMove?.displayUserId !== this._userId) {
            throw new Error("move bundle identity fields do not match its verified chain");
        }
        const rotationSeed = base64ToBase64Url(bundle.rotationKey || "");
        if (!rotationSeed || rotationSeed !== bundle.record.pendingMove?.nextRotationSeed) {
            throw new Error("move bundle rotation key does not match its signed move state");
        }
        // A synthetic successor proves that the carried seed opens the
        // commitment in the signed move link. The probe is only verified
        // locally and is never submitted to a homeserver.
        const probeLink = this._crypto.userSuccessor(
            bundle.links[bundle.links.length - 1],
            rotationSeed,
            this._crypto.generateSeed(),
            custodian,
            tip.master_key,
            tip.display_user_id,
        );
        const probe = this._crypto.verifyChain([...bundle.links, probeLink]);
        if (!probe.ok || probe.principal !== bundle.record.principal) {
            throw new Error("move bundle next rotation key does not match the signed chain commitment");
        }
    }

    async _validateDestinationCrossSigningKeys(bundle, log) {
        const masterKey = this._crypto.publicKey(base64ToBase64Url(bundle.masterSeed));
        const selfSigningKey = this._crypto.publicKey(base64ToBase64Url(bundle.selfSigningSeed));
        if (masterKey !== bundle.record.masterKey) {
            throw new Error("carried cross-signing master key does not match the principal");
        }
        const response = await this._hsApi.queryKeys({
            device_keys: {[this._userId]: []},
        }, {log}).response();
        const masterKeys = Object.values(response.master_keys?.[this._userId]?.keys || {});
        const selfSigningKeys = Object.values(response.self_signing_keys?.[this._userId]?.keys || {});
        if (!masterKeys.includes(masterKey) || !selfSigningKeys.includes(selfSigningKey)) {
            throw new Error("destination account does not publish the carried cross-signing keys");
        }
    }

    /**
     * Send a non-state event (message, reaction, redaction…) in a Cygnus room; returns its event ID.
     * `txnId` should be the pending event's, so a retry resends the same signed event and the
     * remote echo clears the local one.
     */
    async sendRoomEvent(roomId, type, content, txnId, log) {
        const identity = this._requireIdentity();
        const {eventId} = await this._signer(identity).send({roomId, type, content}, {txnId, log});
        return eventId;
    }

    /** Resolve a Matrix user ID to its principal, for invites, kicks and bans (§9). */
    async lookupPrincipal(userId, log) {
        await this.load(log);
        this._requireSupport();
        const {principal} = await this._hsApi.cygnusLookupPrincipal(userId, {log}).response();
        const parsed = this._crypto.parsePrincipal(principal);
        if (!parsed.ok || parsed.principal !== principal) {
            throw new Error(`homeserver returned a non-canonical principal for ${userId}`);
        }
        return principal;
    }

    _rooms() {
        const identity = this._requireIdentity();
        return new CygnusRooms({identity, signer: this._signer(identity)});
    }

    _signer(identity, hsApi = this._hsApi) {
        return new CygnusEventSigner({
            identity,
            crypto: this._crypto,
            hsApi,
            storage: this._storage,
            createTxnId: () => `cygnus-${Date.now()}-${this._crypto.generateSeed().slice(0, 8)}`,
        });
    }

    _requireSupport() {
        if (!this._isSupported) {
            throw new Error("your homeserver does not advertise tk.nutra.cygnus");
        }
    }

    _requireIdentity() {
        this._requireSupport();
        const identity = this.identity.get();
        if (!identity) {
            throw new Error("create a Cygnus identity first");
        }
        if (identity.isRetired) {
            throw new Error("this Cygnus identity was moved to another session");
        }
        if (identity.isHandoffPending) {
            throw new Error("this Cygnus identity is being moved and cannot sign yet");
        }
        return identity;
    }

    _deps() {
        return {storage: this._storage, hsApi: this._hsApi, crypto: this._crypto, secretFetcher: this._secretFetcher};
    }
}
