/*
Copyright 2025 New Vector Ltd.
Copyright 2020 Bruno Windels <bruno@windels.cloud>

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {BaseRoom} from "./BaseRoom.js";
import {SyncWriter} from "./timeline/persistence/SyncWriter.js";
import {MemberWriter} from "./timeline/persistence/MemberWriter.js";
import {RelationWriter} from "./timeline/persistence/RelationWriter.js";
import {SendQueue} from "./sending/SendQueue.js";
import {WrappedError} from "../error.js"
import {Heroes} from "./members/Heroes.js";
import {AttachmentUpload} from "./AttachmentUpload.js";
import {DecryptionSource} from "../e2ee/common";
import {iterateResponseStateEvents} from "./common";
import {PowerLevels, EVENT_TYPE as POWERLEVELS_EVENT_TYPE } from "./PowerLevels.js";
import {isCygnusRoomVersion, isPrincipal} from "../cygnus/constants.js";
import {DmlsService} from "../cygnus/DmlsService.js";

const EVENT_ENCRYPTED_TYPE = "m.room.encrypted";

export class Room extends BaseRoom {
    constructor(options) {
        super(options);
        this._roomStateHandler = options.roomStateHandler;
        // TODO: pass pendingEvents to start like pendingOperations?
        const {pendingEvents} = options;
        const relationWriter = new RelationWriter({
            roomId: this.id,
            fragmentIdComparer: this._fragmentIdComparer,
            getOwnUserIds: () => this.ownUserIds
        });
        this._syncWriter = new SyncWriter({
            roomId: this.id,
            fragmentIdComparer: this._fragmentIdComparer,
            relationWriter,
            memberWriter: new MemberWriter(this.id, () => this.isCygnus)
        });
        const {getCygnus} = options;
        this._getCygnus = getCygnus;
        /** Last capability classification seen in the create event. */
        this._dmlsCapability = undefined;
        this._syncOwnUserIds = null;
        this._sendQueue = new SendQueue({
            roomId: this.id, storage: this._storage, hsApi: this._hsApi, pendingEvents,
            // MSC00FC rooms: the device signs each event and submits it through `send_signed`
            getSignedSender: () => {
                const cygnus = getCygnus?.();
                if (!this.isCygnus) {
                    return undefined;
                }
                if (!cygnus) {
                    // never fall back to an unsigned send in a Cygnus room
                    return () => Promise.reject(new Error("this is a Cygnus room; enable the Cygnus feature to send"));
                }
                return (type, content, txnId, log) => cygnus.sendRoomEvent(this.id, type, content, txnId, log);
            },
        });
    }

    get ownUserIds() {
        return this._syncOwnUserIds || super.ownUserIds;
    }

    /** How this room's create content classifies DMLS, once seen. */
    get dmlsCapability() {
        return this._dmlsCapability;
    }

    _resolveOwnUserIds(roomResponse) {
        let isCygnus = this.isCygnus;
        iterateResponseStateEvents(roomResponse, event => {
            if (event.type === "m.room.create" && isCygnusRoomVersion(event.content?.room_version)) {
                isCygnus = true;
            }
        });
        const principal = isCygnus ? this._getCygnus?.()?.identity.get()?.principal : undefined;
        return principal ? [this._user.id, principal] : [this._user.id];
    }

    _setEncryption(roomEncryption) {
        if (super._setEncryption(roomEncryption)) {
            this._sendQueue.enableEncryption(this._roomEncryption);
            return true;
        }
        return false;
    }

    async prepareSync(...args) {
        try {
            return await this._prepareSync(...args);
        } catch (err) {
            // a failed prepare must not leave this sync's own IDs behind
            this._syncOwnUserIds = null;
            throw err;
        }
    }

    async _prepareSync(roomResponse, membership, newKeys, txn, log) {
        this._syncOwnUserIds = this._resolveOwnUserIds(roomResponse);
        log.set("id", this.id);
        if (newKeys) {
            log.set("newKeys", newKeys.length);
        }
        let summaryChanges = this._summary.data.applySyncResponse(roomResponse, membership, this.ownUserIds);
        const capability = DmlsService.capabilityFromRoomResponse(roomResponse);
        if (capability) {
            this._dmlsCapability = capability;
        }
        // A create content with a DMLS block owns encryption for this room,
        // including a version this client does not implement (never Megolm).
        const dmlsSelected = !!this._dmlsCapability &&
            this._dmlsCapability.reason !== "not_cygnus" &&
            this._dmlsCapability.reason !== "absent";
        let roomEncryption = this._roomEncryption;
        // encryption is enabled in this sync
        if (!roomEncryption && summaryChanges.encryption && !dmlsSelected) {
            log.set("enableEncryption", true);
            roomEncryption = this._createRoomEncryption(this, summaryChanges.encryption);
        }

        let retryEntries;
        let decryptPreparation;
        if (roomEncryption) {
            let eventsToDecrypt = roomResponse?.timeline?.events || [];
            // when new keys arrive, also see if any older events can now be retried to decrypt
            if (newKeys) {
                // TODO: if a key is considered by roomEncryption.prepareDecryptAll to use for decryption,
                // key.eventIds will be set. We could somehow try to reuse that work, but retrying also needs
                // to happen if a key is not needed to decrypt this sync or there are indeed no encrypted messages
                // in this sync at all.
                retryEntries = await this._getSyncRetryDecryptEntries(newKeys, roomEncryption, txn);
                if (retryEntries.length) {
                    log.set("retry", retryEntries.length);
                    eventsToDecrypt = eventsToDecrypt.concat(retryEntries.map(entry => entry.event));
                }
            }
            eventsToDecrypt = eventsToDecrypt.filter(event => {
                return event?.type === EVENT_ENCRYPTED_TYPE;
            });
            if (eventsToDecrypt.length) {
                decryptPreparation = await roomEncryption.prepareDecryptAll(
                    eventsToDecrypt, newKeys, DecryptionSource.Sync, txn);
            }
        }

        return {
            roomEncryption,
            summaryChanges,
            decryptPreparation,
            decryptChanges: null,
            retryEntries
        };
    }

    async afterPrepareSync(preparation, parentLog) {
        if (preparation.decryptPreparation) {
            await parentLog.wrap("decrypt", async log => {
                log.set("id", this.id);
                preparation.decryptChanges = await preparation.decryptPreparation.decrypt();
                preparation.decryptPreparation = null;
            }, parentLog.level.Detail);
        }
    }

    /** @package */
    async writeSync(...args) {
        try {
            return await this._writeSync(...args);
        } catch (err) {
            // `afterSync` will not run for a failed write; do not keep this sync's own IDs
            this._syncOwnUserIds = null;
            throw err;
        }
    }

    async _writeSync(roomResponse, isInitialSync, {summaryChanges, decryptChanges, roomEncryption, retryEntries}, txn, log) {
        log.set("id", this.id);
        const isRejoin = summaryChanges.isNewJoin(this._summary.data);
        if (isRejoin) {
            // remove all room state before calling syncWriter,
            // so no old state sticks around
            txn.roomState.removeAllForRoom(this.id);
            txn.roomMembers.removeAllForRoom(this.id);
        }
        const {entries: newEntries, updatedEntries, newLiveKey, memberChanges, memberSync} =
            await log.wrap("syncWriter", log => this._syncWriter.writeSync(
                roomResponse, isRejoin, summaryChanges.hasFetchedMembers, txn, log), log.level.Detail);
        let decryption;
        if (decryptChanges) {
            decryption = await log.wrap("decryptChanges", log => decryptChanges.write(txn, log));
            log.set("decryptionResults", decryption.results.size);
            log.set("decryptionErrors", decryption.errors.size);
            if (this._isTimelineOpen) {
                await decryption.verifyKnownSenders(txn);
            }
            decryption.applyToEntries(newEntries);
            if (retryEntries?.length) {
                decryption.applyToEntries(retryEntries);
                updatedEntries.push(...retryEntries);
            }
        }
        log.set("newEntries", newEntries.length);
        log.set("updatedEntries", updatedEntries.length);
        let encryptionChanges;
        // pass member changes to device tracker
        if (roomEncryption) {
            encryptionChanges = await roomEncryption.writeSync(roomResponse, memberChanges, txn, log);
            log.set("shouldFlushKeyShares", encryptionChanges.shouldFlush);
        }
        const allEntries = newEntries.concat(updatedEntries);
        // also apply (decrypted) timeline entries to the summary changes
        summaryChanges = summaryChanges.applyTimelineEntries(
            allEntries, isInitialSync, !this._isTimelineOpen, this.ownUserIds);
        
        // if we've have left the room, remove the summary
        if (summaryChanges.membership !== "join") {
            txn.roomSummary.remove(this.id);
        } else {
            // write summary changes, and unset if nothing was actually changed
            summaryChanges = this._summary.writeData(summaryChanges, txn);
        }
        if (summaryChanges) {
            log.set("summaryChanges", summaryChanges.changedKeys(this._summary.data));
        }
        // fetch new members while we have txn open,
        // but don't make any in-memory changes yet
        let heroChanges;
        // if any hero changes their display name, the summary in the room response
        // is also updated, which will trigger a RoomSummary update
        // and make summaryChanges non-falsy here
        if (summaryChanges?.needsHeroes) {
            // room name disappeared, open heroes
            if (!this._heroes) {
                this._heroes = new Heroes(this._roomId);
            }
            heroChanges = await this._heroes.calculateChanges(summaryChanges.heroes, memberChanges, txn);
        }
        let removedPendingEvents;
        if (Array.isArray(roomResponse.timeline?.events)) {
            removedPendingEvents = await this._sendQueue.removeRemoteEchos(roomResponse.timeline.events, txn, log);
        }
        const powerLevelsEvent = this._getPowerLevelsEvent(roomResponse);
        await this._runRoomStateHandlers(roomResponse, memberSync, txn, log);
        return {
            roomResponse,
            summaryChanges,
            roomEncryption,
            newEntries,
            updatedEntries,
            newLiveKey,
            removedPendingEvents,
            memberChanges,
            heroChanges,
            powerLevelsEvent,
            encryptionChanges,
            decryption
        };
    }

    /**
     * @package
     * Called with the changes returned from `writeSync` to apply them and emit changes.
     * No storage or network operations should be done here.
     */
    afterSync(changes, log) {
        try {
            this._afterSync(changes, log);
        } finally {
            this._syncOwnUserIds = null;
        }
    }

    _afterSync(changes, log) {
        const {
            summaryChanges, newEntries, updatedEntries, newLiveKey,
            removedPendingEvents, memberChanges, powerLevelsEvent,
            heroChanges, roomEncryption, roomResponse, encryptionChanges
        } = changes;
        log.set("id", this.id);
        this._syncWriter.afterSync(newLiveKey);
        this._setEncryption(roomEncryption);
        if (this._roomEncryption) {
            this._roomEncryption.afterSync(encryptionChanges);
        }
        const dmls = this._getCygnus?.()?.dmls;
        if (dmls && roomResponse?.timeline?.events?.length) {
            // Apply/merge/reboot/external-commit events are protocol traffic.
            // Persist their state after the sync transaction commits; a failed
            // event is retried by the next sync.
            dmls.enqueueRoomEvents(this.id, roomResponse.timeline.events, log)
                .catch(err => log.catch(err));
        }
        if (memberChanges.size) {
            if (this._changedMembersDuringSync) {
                for (const [userId, memberChange] of memberChanges.entries()) {
                    this._changedMembersDuringSync.set(userId, memberChange.member);
                }
            }
            if (this._memberList) {
                this._memberList.afterSync(memberChanges);
            }
            this._roomStateHandler.updateRoomMembers(this, memberChanges);
            if (this._observedMembers) {
                this._updateObservedMembers(memberChanges);
            }
            if (this._timeline) {
                for (const [userId, memberChange] of memberChanges.entries()) {
                    if (this.ownUserIds.includes(userId)) {
                        this._timeline.updateOwnMember(memberChange.member);
                        break;
                    }
                }
            }
        }
        let emitChange = false;
        if (summaryChanges) {
            this._summary.applyChanges(summaryChanges);
            if (!this._summary.data.needsHeroes) {
                this._heroes = null;
            }
            emitChange = true;
        }
        if (this._heroes && heroChanges) {
            const oldName = this.name;
            this._heroes.applyChanges(heroChanges, this._summary.data, log);
            if (oldName !== this.name) {
                emitChange = true;
            }
        }
        if (powerLevelsEvent) {
            this._updatePowerLevels(powerLevelsEvent);
        }
        if (emitChange) {
            this._emitUpdate();
        }
        if (this._timeline) {
            // these should not be added if not already there
            this._timeline.replaceEntries(updatedEntries);
            this._timeline.addEntries(newEntries);
        }
        if (this._observedEvents) {
            this._observedEvents.updateEvents(updatedEntries);
            this._observedEvents.updateEvents(newEntries);
        }
        if (removedPendingEvents) {
            this._sendQueue.emitRemovals(removedPendingEvents);
        }
        this._emitSyncRoomState(roomResponse);
    }

    _updateObservedMembers(memberChanges) {
        for (const [userId, memberChange] of memberChanges) {
            const observableMember = this._observedMembers.get(userId);
            if (observableMember) {
                observableMember.set(memberChange.member);
            }
        }
    }

    _getPowerLevelsEvent(roomResponse) {
        let powerLevelEvent;
        iterateResponseStateEvents(roomResponse, event => {
            if(event.state_key === "" && event.type === POWERLEVELS_EVENT_TYPE) {
                powerLevelEvent = event;
            }

        });
        return powerLevelEvent;
    }

    _updatePowerLevels(powerLevelEvent) {
        if (this._powerLevels) {
            const newPowerLevels = new PowerLevels({
                powerLevelEvent,
                ownUserId: this.ownRoomUserId,
                membership: this.membership,
            });
            this._powerLevels.set(newPowerLevels);
        }
    }

    /**
     * Only called if the result of writeSync had `needsAfterSyncCompleted` set.
     * Can be used to do longer running operations that resulted from the last sync,
     * like network operations.
     */
    async afterSyncCompleted({encryptionChanges, decryption, newEntries, updatedEntries}, log) {
        const shouldFlushKeys = encryptionChanges?.shouldFlush;
        const shouldFetchUnverifiedSenders = this._isTimelineOpen && decryption?.hasUnverifiedSenders;
        // only log rooms where we actually do something
        if (shouldFlushKeys || shouldFetchUnverifiedSenders) {
            await log.wrap({l: "room", id: this.id}, async log => {
                const promises = [];
                if (shouldFlushKeys) {
                    promises.push(this._roomEncryption.flushPendingRoomKeyShares(this._hsApi, null, log));
                }
                if (shouldFetchUnverifiedSenders) {
                    const promise = log.wrap("verify senders", (async log => {
                        const newlyVerifiedDecryption = await decryption.fetchAndVerifyRemainingSenders(this._hsApi, log);
                        const verifiedEntries = [];
                        const updateCallback = entry => verifiedEntries.push(entry);
                        newlyVerifiedDecryption.applyToEntries(newEntries, updateCallback);
                        newlyVerifiedDecryption.applyToEntries(updatedEntries, updateCallback);
                        log.set("verifiedEntries", verifiedEntries.length);
                        this._timeline?.replaceEntries(verifiedEntries);
                        this._observedEvents?.updateEvents(verifiedEntries);
                    }));
                    promises.push(promise);
                }
                await Promise.all(promises);
            });
        }
    }

    /** @package */
    start(pendingOperations, parentLog) {
        if (this._roomEncryption) {
            const roomKeyShares = pendingOperations?.get("share_room_key");
            if (roomKeyShares) {
                // if we got interrupted last time sending keys to newly joined members
                parentLog.wrapDetached("flush room keys", log => {
                    log.set("id", this.id);
                    return this._roomEncryption.flushPendingRoomKeyShares(this._hsApi, roomKeyShares, log);
                });
            }
        }
        
        this._sendQueue.resumeSending(parentLog);
    }

    /** @package */
    async load(summary, txn, log) {
        try {
            await super.load(summary, txn, log);
            await this._syncWriter.load(txn, log);
        } catch (err) {
            throw new WrappedError(`Could not load room ${this._roomId}`, err);
        }
    }

    async _writeGapFill(gapChunk, txn, log) {
        const removedPendingEvents = await this._sendQueue.removeRemoteEchos(gapChunk, txn, log);
        return removedPendingEvents;
    }

    _applyGapFill(removedPendingEvents) {
        this._sendQueue.emitRemovals(removedPendingEvents);
    }

    /** @public */
    sendEvent(eventType, content, attachments, log = null) {
        return this._platform.logger.wrapOrRun(log, "send", log => {
            log.set("id", this.id);
            return this._sendQueue.enqueueEvent(eventType, content, attachments, log);
        });
    }

    /** @public */
    sendRedaction(eventIdOrTxnId, reason, log = null) {
        return this._platform.logger.wrapOrRun(log, "redact", log => {
            log.set("id", this.id);
            return this._sendQueue.enqueueRedaction(eventIdOrTxnId, reason, log);
        });
    }

    /** @public */
    async ensureMessageKeyIsShared(log = null) {
        if (!this._roomEncryption) {
            return;
        }
        return this._platform.logger.wrapOrRun(log, "ensureMessageKeyIsShared", log => {
            log.set("id", this.id);
            return this._roomEncryption.ensureMessageKeyIsShared(this._hsApi, log);
        });
    }

    get avatarColorId() {
        return this._heroes?.roomAvatarColorId || this._roomId;
    }

    get isUnread() {
        return this._summary.data.isUnread;
    }

    get notificationCount() {
        return this._summary.data.notificationCount;
    }
    
    get highlightCount() {
        return this._summary.data.highlightCount;
    }

    get isTrackingMembers() {
        return this._summary.data.isTrackingMembers;
    }

    async _getLastEventId() {
        const lastKey = this._syncWriter.lastMessageKey;
        if (lastKey) {
            const txn = await this._storage.readTxn([
                this._storage.storeNames.timelineEvents,
            ]);
            const eventEntry = await txn.timelineEvents.get(this._roomId, lastKey);
            return eventEntry?.event?.event_id;
        }
    }

    /**
     * Clear the unreaad count in the room, and optionally send a read receipt
     * @param {*} log Logger
     * @param {boolean} sendReceipt Should a receipt be sent.
     * @returns 
     */
    async clearUnread(log = null, sendReceipt = true) {
        if (this.isUnread || this.notificationCount) {
            return await this._platform.logger.wrapOrRun(log, "clearUnread", async log => {
                log.set("id", this.id);
                const txn = await this._storage.readWriteTxn([
                    this._storage.storeNames.roomSummary,
                ]);
                let data;
                try {
                    data = this._summary.writeClearUnread(txn);
                } catch (err) {
                    txn.abort();
                    throw err;
                }
                await txn.complete();
                this._summary.applyChanges(data);
                this._emitUpdate();
                
                try {
                    const lastEventId = sendReceipt && await this._getLastEventId();
                    if (lastEventId) {
                        await this._hsApi.receipt(this._roomId, "m.read", lastEventId);
                    }
                } catch (err) {
                    // ignore ConnectionError
                    if (err.name !== "ConnectionError") {
                        throw err;
                    }
                }
            });
        }
    }

    leave(log = null) {
        return this._platform.logger.wrapOrRun(log, "leave room", async log => {
            log.set("id", this.id);
            if (this.isCygnus) {
                const cygnus = this._getCygnus?.();
                if (!cygnus) throw new Error("Cygnus is unavailable for this room");
                await cygnus.leaveRoom(this.id, log);
                return;
            }
            await this._hsApi.leave(this.id, {log}).response();
        });
    }

    /**
     * Send a state event in this room. Cygnus rooms route it through the
     * device-signed `send_signed` path instead of the plain `/state` endpoint.
     */
    sendStateEvent(type, stateKey, content, log = null, txnId) {
        return this._platform.logger.wrapOrRun(log, "sendState", async log => {
            log.set("id", this.id);
            log.set("type", type);
            if (this.isCygnus) {
                const cygnus = this._getCygnus?.();
                if (!cygnus) throw new Error("Cygnus is unavailable for this room");
                return cygnus.sendStateEvent(this.id, type, content, stateKey, log, txnId);
            }
            const response = await this._hsApi.sendState(this.id, type, stateKey, content, {log}).response();
            return response.event_id;
        });
    }

    setName(name, log = null, txnId) {
        return this.sendStateEvent("m.room.name", "", {name}, log, txnId);
    }

    setTopic(topic, log = null, txnId) {
        return this.sendStateEvent("m.room.topic", "", {topic}, log, txnId);
    }

    setJoinRule(joinRule, log = null, txnId) {
        return this.sendStateEvent("m.room.join_rules", "", {join_rule: joinRule}, log, txnId);
    }

    setPowerLevels(content, log = null, txnId) {
        return this.sendStateEvent("m.room.power_levels", "", content, log, txnId);
    }

    async inviteUser(userId, reason, log = null, txnId) {
        if (!userId) {
            throw new Error("userId is null/undefined");
        }
        if (this.isCygnus) {
            const cygnus = this._getCygnus?.();
            if (!cygnus) throw new Error("Cygnus is unavailable for this room");
            const principal = isPrincipal(userId) ? userId : await cygnus.lookupPrincipal(userId, log);
            return cygnus.sendMembershipEvent(this.id, principal, "invite", reason, log, txnId);
        }
        await this._hsApi.invite(this.id, userId, reason, {log}).response();
    }

    async kickUser(userId, reason, log = null, txnId) {
        return this._changeOtherMembership("kick", userId, reason, log, txnId);
    }

    async banUser(userId, reason, log = null, txnId) {
        return this._changeOtherMembership("ban", userId, reason, log, txnId);
    }

    async _changeOtherMembership(membership, userId, reason, log, txnId) {
        if (!userId) {
            throw new Error("userId is null/undefined");
        }
        // A kick is an ordinary leave event sent by someone else; "kick" is not
        // a Matrix membership value. Normalise once, before either send path.
        const eventMembership = membership === "kick" ? "leave" : membership;
        if (this.isCygnus) {
            const cygnus = this._getCygnus?.();
            if (!cygnus) throw new Error("Cygnus is unavailable for this room");
            const principal = isPrincipal(userId) ? userId : await cygnus.lookupPrincipal(userId, log);
            return cygnus.sendMembershipEvent(this.id, principal, eventMembership, reason, log, txnId);
        }
        const content = {membership: eventMembership};
        if (reason) {
            content.reason = reason;
        }
        const response = await this._hsApi.sendState(this.id, "m.room.member", userId, content, {log}).response();
        return response.event_id;
    }

    /* called by BaseRoom to pass pendingEvents when opening the timeline */
    _getPendingEvents() {
        return this._sendQueue.pendingEvents;
    }

    /** global room state handlers, run during writeSync step */
    _runRoomStateHandlers(roomResponse, memberSync, txn, log) {
        const promises = [];
        iterateResponseStateEvents(roomResponse, event => {
            promises.push(this._roomStateHandler.handleRoomState(this, event, memberSync, txn, log));
        });
        return Promise.all(promises);
    }

    /** local room state observers, run during afterSync step */
    _emitSyncRoomState(roomResponse) {
        iterateResponseStateEvents(roomResponse, event => {
            for (const handler of this._roomStateObservers) {
                handler.handleStateEvent(event);
            }
        });
    }

    /** @package */
    writeIsTrackingMembers(value, txn) {
        return this._summary.writeIsTrackingMembers(value, txn);
    }

    /** @package */
    applyIsTrackingMembersChanges(changes) {
        this._summary.applyChanges(changes);
    }

    createAttachment(blob, filename) {
        return new AttachmentUpload({blob, filename, platform: this._platform});
    }

    dispose() {
        super.dispose();
        this._sendQueue.dispose();
    }
}
