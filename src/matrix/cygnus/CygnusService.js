/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {ObservableValue} from "../../observable/value";
import {CygnusCrypto} from "./CygnusCrypto.js";
import {CygnusIdentity} from "./CygnusIdentity.js";
import {CygnusEventSigner} from "./CygnusEventSigner.js";
import {CygnusRooms} from "./CygnusRooms.js";

/** The `unstable_features` flag a homeserver advertises for MSC00FC. */
export const CYGNUS_UNSTABLE_FEATURE = "tk.nutra.cygnus";

/** Matrix secrets are unpadded standard base64; Cygnus seeds are unpadded base64url. */
function base64ToBase64Url(value) {
    return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Session-level entry point for MSC00FC: whether the homeserver supports it,
 * this account's principal (if any), and the identity and room flows.
 *
 * Nothing loads unless the Cygnus feature flag is on, so ordinary sessions
 * never fetch the wasm module.
 */
export class CygnusService {
    constructor({storage, hsApi, secretFetcher, userId, deviceId, getRandomValues, wasmSource}) {
        this._storage = storage;
        this._hsApi = hsApi;
        this._secretFetcher = secretFetcher;
        this._userId = userId;
        this._deviceId = deviceId;
        this._wasmSource = wasmSource;
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
        this.identity.set(await CygnusIdentity.load(this._deps()));
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
        const [master, selfSigning] = await Promise.all([
            this._secretFetcher.getSecret("m.cross_signing.master"),
            this._secretFetcher.getSecret("m.cross_signing.self_signing"),
        ]);
        if (!master || !selfSigning) {
            throw new Error("Set up cross-signing and unlock secret storage first: the principal's master key is your cross-signing master key.");
        }
        const identity = await CygnusIdentity.create({
            ...this._deps(),
            masterSeed: base64ToBase64Url(master),
            selfSigningSeed: base64ToBase64Url(selfSigning),
            deviceId: this._deviceId,
            displayUserId: this._userId,
            log,
        });
        this.identity.set(identity);
        return identity;
    }

    async rotate(log) {
        const identity = this._requireIdentity();
        await identity.rotate({log});
        this.identity.set(identity);
    }

    createRoom(options, log) {
        return this._rooms().createRoom({...options, log});
    }

    joinRoom(roomId, log) {
        return this._rooms().joinRoom(roomId, {log});
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

    _signer(identity) {
        return new CygnusEventSigner({
            identity,
            crypto: this._crypto,
            hsApi: this._hsApi,
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
        return identity;
    }

    _deps() {
        return {storage: this._storage, hsApi: this._hsApi, crypto: this._crypto};
    }
}
