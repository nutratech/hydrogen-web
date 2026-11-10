/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {SESSION_E2EE_KEY_PREFIX} from "../e2ee/common";

/**
 * Session-store key for the identity record. The `e2ee:` prefix makes
 * SessionStore mirror it to localStorage, which gives the rotation key the
 * second local copy MSC00FC §9 asks for.
 */
export const IDENTITY_SESSION_KEY = `${SESSION_E2EE_KEY_PREFIX}cygnus.identity`;
export const ROTATION_KEY_SECRET = "m.principal.rotation_key";

function toBase64Standard(value) {
    return value.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "") + "=".repeat((4 - value.length % 4) % 4);
}

function toBase64Url(value) {
    return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The user's MSC00FC principal and the private material this device holds
 * for it.
 *
 * - The master and self-signing keys are the account's Matrix cross-signing
 *   keys (§9: cross-signing trust is keyed to the principal). They are read
 *   from secret storage when needed and not copied here.
 * - The device key is a dedicated Cygnus signing key: Olm cannot export the
 *   device's own Ed25519 seed, and §5.2.1 only needs a key the self-signing
 *   key certifies.
 * - `rotationSeed` is the key the current tip link commits to. Whoever holds
 *   it can advance the chain, so it never goes to the homeserver.
 *
 * Record fields: principal, links (genesis first), custodian, displayUserId,
 * masterKey, deviceId, deviceSeed, deviceCertificate, rotationSeed,
 * revokedDeviceIds, and pendingRotation ({link, nextRotationSeed}) while a
 * rotation is in flight.
 */
export class CygnusIdentity {
    constructor(record, {storage, hsApi, crypto, secretFetcher}) {
        this._record = record;
        this._storage = storage;
        this._hsApi = hsApi;
        this._crypto = crypto;
        this._secretFetcher = secretFetcher;
    }

    static async load({storage, hsApi, crypto, secretFetcher}) {
        const txn = await storage.readTxn([storage.storeNames.session]);
        const record = await txn.session.get(IDENTITY_SESSION_KEY);
        return record ? new CygnusIdentity(record, {storage, hsApi, crypto, secretFetcher}) : undefined;
    }

    /**
     * Mint a user principal with the custodian (§7) and certify a new device
     * key under the account's cross-signing keys.
     *
     * @param {object} options
     * @param {string} options.masterSeed cross-signing master seed (unpadded base64url)
     * @param {string} options.selfSigningSeed cross-signing self-signing seed
     * @param {string} options.deviceId this device's Matrix device ID
     * @param {string} options.displayUserId the account's Matrix user ID
     */
    static async create({storage, hsApi, crypto, secretFetcher, masterSeed, selfSigningSeed, deviceId, displayUserId, log}) {
        const masterKey = crypto.publicKey(masterSeed);
        const rotationSeed = crypto.generateSeed();
        await secretFetcher?.writeSecret?.(ROTATION_KEY_SECRET, toBase64Standard(rotationSeed), log);
        const nextCommit = crypto.rotationCommitment(rotationSeed);
        const response = await hsApi.cygnusCreatePrincipal(masterKey, nextCommit, {log}).response();
        const genesis = crypto.verifyUserPrincipalResponse(rotationSeed, masterKey, response.principal, response.links);
        const tip = crypto.parseLink(genesis);
        if (tip.display_user_id !== displayUserId) {
            throw new Error(`custodian minted ${tip.display_user_id}, expected ${displayUserId}`);
        }
        const deviceSeed = crypto.generateSeed();
        const deviceCertificate = crypto.createDeviceCertificate(response.principal, masterSeed, selfSigningSeed, deviceId, deviceSeed);
        const record = {
            principal: response.principal,
            links: [genesis],
            custodian: tip.custodian,
            displayUserId: tip.display_user_id,
            masterKey,
            deviceId,
            deviceSeed,
            deviceCertificate,
            rotationSeed,
            revokedDeviceIds: [],
        };
        const identity = new CygnusIdentity(record, {storage, hsApi, crypto, secretFetcher});
        await identity._persist();
        return identity;
    }

    get principal() { return this._record.principal; }
    get displayUserId() { return this._record.displayUserId; }
    get custodian() { return this._record.custodian; }
    get masterKey() { return this._record.masterKey; }
    get deviceId() { return this._record.deviceId; }
    get deviceCertificate() { return this._record.deviceCertificate; }
    get revokedDeviceIds() { return this._record.revokedDeviceIds.slice(); }
    get links() { return this._record.links.slice(); }
    /** Height of the tip link; genesis is 0. */
    get height() { return this._record.links.length - 1; }
    /** True when a rotation was signed but the custodian has not confirmed it. */
    get hasPendingRotation() { return !!this._record.pendingRotation; }
    get pendingMove() { return this._record.pendingMove; }
    get pendingRebindRoomIds() { return this._record.pendingRebindRooms?.slice() || []; }

    /** Remember a permanently revoked Matrix device ID for the next custodian import. */
    async revokeDevice(deviceId) {
        if (!deviceId || typeof deviceId !== "string") {
            throw new TypeError("a Matrix device ID is required");
        }
        if (this._record.revokedDeviceIds.includes(deviceId)) return;
        this._record = {
            ...this._record,
            revokedDeviceIds: [...this._record.revokedDeviceIds, deviceId],
        };
        await this._persist();
    }

    /** Device-sign an event that already carries this identity's certificate. */
    signEvent(event) {
        return this._crypto.signEvent(event, this.principal, this.deviceId, this._record.deviceSeed);
    }

    /**
     * Advance the user chain one link under the same custodian: reveal the
     * committed rotation key, commit to a fresh one, and hand the link to the
     * custodian, which relays `m.room.user_epoch` advancements (§7).
     *
     * The signed link and the next seed are stored before the request goes
     * out. The current rotation key is spent once the link is signed, so if
     * the request fails or the tab closes, the same link is resent (see
     * `hasPendingRotation`) rather than losing the only key that can extend the
     * chain.
     */
    async rotate({log} = {}) {
        // A pending move has already signed the next link with the current
        // rotation key; a second link at that height would be a burn (§4.2).
        if (this._record.pendingMove) {
            throw new Error("finish the pending Cygnus move before rotating keys");
        }
        if (!this._record.pendingRotation) {
            await this._assertRotationKey(this._record.rotationSeed);
            const nextRotationSeed = this._crypto.generateSeed();
            const link = this._crypto.userSuccessor(
                this._record.links[this._record.links.length - 1],
                this._record.rotationSeed,
                nextRotationSeed,
                this.custodian,
                this.masterKey,
                this.displayUserId,
            );
            this._record = {...this._record, pendingRotation: {link, nextRotationSeed}};
            await this._persist();
        }
        const {link, nextRotationSeed} = this._record.pendingRotation;
        await this._ensureNextRotationKey(this._record.rotationSeed, nextRotationSeed);
        // §9 defines import for both same-custodian advancement and moves.
        await this._hsApi.cygnusImportPrincipal([link], this._record.revokedDeviceIds, {log}).response();
        const links = [...this._record.links, link];
        const verified = this._crypto.verifyChain(links);
        if (!verified.ok || verified.principal !== this.principal) {
            throw new Error(`rotated chain does not verify: ${verified.error ?? verified.principal}`);
        }
        const {pendingRotation, ...rest} = this._record; // eslint-disable-line no-unused-vars
        this._record = {...rest, links, rotationSeed: nextRotationSeed};
        await this._persist();
    }

    async prepareMove({custodian, displayUserId, roomIds}) {
        if (this._record.pendingMove) {
            const pending = this._record.pendingMove;
            if (pending.custodian !== custodian || pending.displayUserId !== displayUserId) {
                throw new Error("another Cygnus move is already in progress");
            }
            await this._ensureNextRotationKey(this._record.rotationSeed, pending.nextRotationSeed);
            return pending;
        }
        if (this._record.pendingRotation) {
            throw new Error("finish the pending Cygnus rotation before moving homeservers");
        }
        await this._assertRotationKey(this._record.rotationSeed);
        const nextRotationSeed = this._crypto.generateSeed();
        const link = this._crypto.userSuccessor(
            this._record.links[this._record.links.length - 1],
            this._record.rotationSeed,
            nextRotationSeed,
            custodian,
            this.masterKey,
            displayUserId,
        );
        const pendingMove = {
            link,
            nextRotationSeed,
            custodian,
            displayUserId,
            roomIds: [...new Set(roomIds)],
        };
        this._record = {...this._record, pendingMove};
        await this._persist();
        await this._ensureNextRotationKey(this._record.rotationSeed, nextRotationSeed);
        return pendingMove;
    }

    async completeMove(links, principal, hsApi) {
        const pending = this._record.pendingMove;
        if (!pending) throw new Error("no Cygnus move is in progress");
        if (!Array.isArray(links) || !links.length) throw new Error("destination homeserver returned no principal chain");
        const verified = this._crypto.verifyChain(links);
        if (!verified.ok || verified.principal !== this.principal || (principal && principal !== this.principal) || links[links.length - 1] !== pending.link) {
            throw new Error(`imported chain does not match this move: ${verified.error ?? verified.principal}`);
        }
        const {pendingMove, ...rest} = this._record; // eslint-disable-line no-unused-vars
        this._record = {
            ...rest,
            links,
            custodian: pending.custodian,
            displayUserId: pending.displayUserId,
            rotationSeed: pending.nextRotationSeed,
            pendingRebindRooms: pending.roomIds,
        };
        if (hsApi) this._hsApi = hsApi;
        await this._persist();
    }

    async markRoomRebound(roomId) {
        const pendingRebindRooms = (this._record.pendingRebindRooms || []).filter(id => id !== roomId);
        this._record = {...this._record, pendingRebindRooms};
        await this._persist();
    }

    async _assertRotationKey(expectedSeed) {
        if (!this._secretFetcher) return;
        const stored = await this._secretFetcher.readSecretStorage(ROTATION_KEY_SECRET);
        if (!stored || toBase64Url(stored) !== expectedSeed) {
            throw new Error("secret-storage rotation key differs from this device's current key; refusing to sign a chain link");
        }
    }

    async _ensureNextRotationKey(currentSeed, nextSeed) {
        if (!this._secretFetcher) return;
        const stored = await this._secretFetcher.readSecretStorage(ROTATION_KEY_SECRET);
        const storedSeed = stored ? toBase64Url(stored) : undefined;
        if (storedSeed === nextSeed) return;
        if (storedSeed !== currentSeed) {
            throw new Error("secret-storage rotation key differs from this device's current key; refusing to submit the signed link");
        }
        await this._secretFetcher.writeSecret(ROTATION_KEY_SECRET, toBase64Standard(nextSeed));
    }

    async _persist() {
        const txn = await this._storage.readWriteTxn([this._storage.storeNames.session]);
        try {
            txn.session.set(IDENTITY_SESSION_KEY, this._record);
        } catch (err) {
            txn.abort();
            throw err;
        }
        await txn.complete();
    }
}
