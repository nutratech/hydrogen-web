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

    /** Permanently revoke another Matrix device and publish the list with a chain advancement. */
    async revokeDevice(deviceId, log) {
        const identity = this._requireIdentity();
        if (deviceId === identity.deviceId) {
            throw new Error("another active Cygnus signer must revoke this device");
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

    /**
     * Move a principal while running from the authenticated destination
     * session. The source session exports its secret material explicitly;
     * secret storage is account data on that source homeserver and is not
     * visible to this session.
     */
    async moveFrom(sourceService, {custodian, roomIds = [], log} = {}) {
        this._requireSupport();
        if (!sourceService || sourceService === this) {
            throw new Error("an authenticated source session is required for a Cygnus move");
        }
        let identity = this.identity.get();
        const importAlreadyCompleted = identity?.isHandoffPending && !identity.pendingMove &&
            identity.custodian === custodian && identity.displayUserId === this._userId;
        if ((identity?.pendingRebindRoomIds.length || importAlreadyCompleted) && !identity.pendingRevocationImport) {
            let bundle;
            if (identity.isHandoffPending) {
                const sourceIdentity = sourceService.identity.get();
                bundle = sourceIdentity?.isRetired ? undefined : await sourceService.exportMoveBundle(log);
                // The import may have succeeded just before the app stopped.
                // Certification must still precede handoff completion and every
                // rebinding event signed through the destination custodian.
                if (!identity.deviceCertificate) {
                    if (!bundle) {
                        throw new Error("destination device certification was not completed before the source identity was retired");
                    }
                    await this._validateDestinationCrossSigningKeys(bundle, log);
                    await identity.certifyDevice({
                        deviceId: this._deviceId,
                        masterSeed: base64ToBase64Url(bundle.masterSeed),
                        selfSigningSeed: base64ToBase64Url(bundle.selfSigningSeed),
                    });
                }
                await this._finishMoveHandoff(identity, sourceService, log, bundle);
            }
            return this.resumeMoveRebinds(log);
        }
        const bundle = await sourceService.exportMoveBundle(log);
        try {
            this._validateMoveBundle(bundle, custodian);
            await this._validateDestinationCrossSigningKeys(bundle, log);
            if (!this._secretFetcher?.hasSecretStorage) {
                throw new Error("unlock destination secret storage before moving the Cygnus identity");
            }
        } catch (err) {
            await sourceService.cancelMoveHandoff();
            throw err;
        }

        if (!identity) {
            const record = {
                ...bundle.record,
                deviceId: this._deviceId,
                deviceSeed: undefined,
                deviceCertificate: undefined,
                handoffPending: true,
                revokedDeviceIds: [...new Set([...bundle.record.revokedDeviceIds, bundle.sourceDeviceId])],
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

        if (!identity.pendingRebindRoomIds.length && !identity.pendingMove) {
            const pendingMove = await identity.prepareMove({
                custodian,
                displayUserId: this._userId,
                roomIds: [...new Set([
                    ...bundle.roomIds,
                    ...roomIds,
                    ...(bundle.record.pendingMove?.roomIds || []),
                ])],
            });
            if (pendingMove.custodian !== custodian || pendingMove.displayUserId !== this._userId) {
                throw new Error("pending Cygnus move targets a different destination");
            }
        }
        if (identity.pendingMove || identity.pendingRevocationImport) {
            const storedRotationKey = await this._secretFetcher.readSecretStorage("m.principal.rotation_key");
            const storedSeed = storedRotationKey ? base64ToBase64Url(storedRotationKey) : undefined;
            const rotationSeedToPersist = identity.pendingMove?.nextRotationSeed || identity.rotationSeed;
            if (storedSeed && storedSeed !== identity.rotationSeed && storedSeed !== rotationSeedToPersist) {
                throw new Error("destination secret storage already contains a different rotation key");
            }
            // The destination copy must be durable before the custodian accepts
            // the link, so a lost response can be retried without key loss.
            await this._secretFetcher.writeSecret("m.principal.rotation_key", base64UrlToBase64(rotationSeedToPersist), log);
            const links = identity.pendingMove ? [...identity.links, identity.pendingMove.link] : identity.links;
            const revokedDeviceIds = [...new Set([...identity.revokedDeviceIds, bundle.sourceDeviceId])];
            const response = await this._hsApi.cygnusImportPrincipal(links, revokedDeviceIds, {log}).response();
            if (identity.pendingMove) {
                await identity.completeMove(response.links, response.principal, this._hsApi);
            } else {
                await identity.adoptImportedChain(response.links, response.principal);
            }
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

    /** Export private move material from this (source) session for explicit local handoff. */
    async exportMoveBundle(log) {
        const identity = this.identity.get();
        if (!identity || identity.isRetired) throw new Error("no active source Cygnus identity is available to move");
        if (identity.hasPendingRotation) {
            await identity.rotate({log});
        }
        await identity.beginMoveHandoff();
        try {
            const [rotationKey, masterSeed, selfSigningSeed] = await Promise.all([
                this._secretFetcher.readSecretStorage("m.principal.rotation_key"),
                this._secretFetcher.readSecretStorage("m.cross_signing.master"),
                this._secretFetcher.readSecretStorage("m.cross_signing.self_signing"),
            ]);
            const expectedRotationKey = identity.pendingMove?.nextRotationSeed || identity.rotationSeed;
            if (!rotationKey || base64ToBase64Url(rotationKey) !== expectedRotationKey) {
                throw new Error("source secret storage does not contain the current Cygnus rotation key");
            }
            if (!masterSeed || !selfSigningSeed || this._crypto.publicKey(base64ToBase64Url(masterSeed)) !== identity.masterKey) {
                throw new Error("source secret storage does not contain the cross-signing keys for this identity");
            }
            const roomIds = await this._joinedCygnusRoomIds();
            return {
                version: 1,
                record: identity.exportMoveRecord(),
                rotationKey,
                masterSeed,
                selfSigningSeed,
                sourceDeviceId: identity.deviceId,
                roomIds: [...new Set([
                    ...roomIds,
                    ...(identity.pendingMove?.roomIds || []),
                    ...identity.pendingRebindRoomIds,
                ])],
            };
        } catch (err) {
            await identity.cancelMoveHandoff();
            throw err;
        }
    }

    /** Stop the source signer and remove its rotation-key copy after destination backup. */
    async retireAfterMove(log) {
        const identity = this.identity.get();
        if (!identity) return;
        if (!identity.isRetired) await identity.retireAfterMove();
        await this._secretFetcher.deleteSecret("m.principal.rotation_key", log);
        this.identity.set(identity);
    }

    async cancelMoveHandoff() {
        const identity = this.identity.get();
        if (identity && !identity.isRetired) await identity.cancelMoveHandoff();
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
        for (const roomId of identity.pendingRebindRoomIds) {
            await rooms.rebindRoom(roomId, {log, via: identity.pendingRebindVia});
            await identity.markRoomRebound(roomId);
        }
        this.identity.set(identity);
    }

    async _finishMoveHandoff(identity, sourceService, log, bundle) {
        const masterSeed = bundle?.masterSeed ?? await this._secretFetcher.readSecretStorage("m.cross_signing.master");
        const selfSigningSeed = bundle?.selfSigningSeed ?? await this._secretFetcher.readSecretStorage("m.cross_signing.self_signing");
        if (!masterSeed || !selfSigningSeed) {
            throw new Error("destination session is missing the carried cross-signing keys");
        }
        const storedRotationKey = await this._secretFetcher.readSecretStorage("m.principal.rotation_key");
        const expectedRotationKey = base64ToBase64Url(identity.rotationSeed);
        if (storedRotationKey && base64ToBase64Url(storedRotationKey) !== expectedRotationKey) {
            throw new Error("destination secret storage contains a different rotation key");
        }
        await this._secretFetcher.writeSecret("m.cross_signing.master", masterSeed, log);
        await this._secretFetcher.writeSecret("m.cross_signing.self_signing", selfSigningSeed, log);
        await this._secretFetcher.writeSecret("m.principal.rotation_key", base64UrlToBase64(identity.rotationSeed), log);
        identity.setSecretFetcher(this._secretFetcher);
        await sourceService.retireAfterMove(log);
        if (identity.isHandoffPending) await identity.finishMoveHandoff();
        this.identity.set(identity);
    }

    _validateMoveBundle(bundle, custodian) {
        if (bundle?.version !== 1 || !bundle.record || !bundle.sourceDeviceId ||
            !Array.isArray(bundle.record.links) || !bundle.record.links.length ||
            typeof bundle.rotationKey !== "string" ||
            typeof bundle.masterSeed !== "string" ||
            typeof bundle.selfSigningSeed !== "string" ||
            !bundle.record.principal || !bundle.record.custodian || !bundle.record.displayUserId ||
            !bundle.record.masterKey || !bundle.record.deviceId) {
            throw new Error("unsupported or incomplete Cygnus move bundle");
        }
        const verified = this._crypto.verifyChain(bundle.record.links);
        if (!verified.ok || verified.principal !== bundle.record.principal) {
            throw new Error(`source identity chain is invalid: ${verified.error ?? verified.principal}`);
        }
        const tip = this._crypto.parseLink(bundle.record.links[bundle.record.links.length - 1]);
        if (bundle.sourceDeviceId !== bundle.record.deviceId ||
            tip.custodian !== bundle.record.custodian ||
            tip.display_user_id !== bundle.record.displayUserId ||
            tip.master_key !== bundle.record.masterKey ||
            !Array.isArray(bundle.record.revokedDeviceIds) ||
            !Array.isArray(bundle.roomIds)) {
            throw new Error("move bundle identity fields do not match its verified chain");
        }
        const rotationSeed = base64ToBase64Url(bundle.rotationKey || "");
        const expectedRotationSeed = bundle.record.pendingMove?.nextRotationSeed || bundle.record.rotationSeed;
        if (!rotationSeed || rotationSeed !== expectedRotationSeed) {
            throw new Error("move bundle rotation key does not match its pending identity state");
        }
        if (bundle.record.pendingMove && bundle.record.pendingMove.custodian !== custodian) {
            throw new Error("source has a pending move to a different custodian");
        }
        const hasPendingRebind = bundle.record.pendingRebindRooms?.length > 0;
        if (!bundle.record.pendingMove && !hasPendingRebind && bundle.record.custodian === custodian) {
            throw new Error("destination custodian is already the identity's current custodian");
        }
        if (hasPendingRebind && bundle.record.custodian !== custodian) {
            throw new Error("pending rebinding state belongs to a different custodian");
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
