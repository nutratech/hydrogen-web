/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {CYGNUS_ROOM_VERSION} from "./constants.js";

/**
 * Room lifecycle for MSC00FC rooms, as the user-signed events a device sends.
 *
 * The epoch events (`m.room.user_epoch` and `m.room.server_epoch`) carry no
 * device signature (§5.2.1). The §9 contract requires the custodian to emit
 * them after create and to prepare them for joins before the client signs the
 * membership event.
 */
export class CygnusRooms {
    constructor({identity, signer}) {
        this._identity = identity;
        this._signer = signer;
    }

    /**
     * Create a room: the create event (§5.6), then the creator's join and the
     * join rule. Returns the room ID, derived from the create event's
     * reference hash.
     */
    async createRoom({name, topic, isPublic = false, log} = {}) {
        const created = await this._signer.send({
            type: "m.room.create",
            stateKey: "",
            content: {
                room_version: CYGNUS_ROOM_VERSION,
                creator_links: {user: this._identity.links},
            },
        }, {log});
        const roomId = `!${created.eventId.slice(1)}`;
        try {
            await this._finishRoom(roomId, {name, topic, isPublic}, log);
        } catch (err) {
            // the room exists now; expose what is left so the caller can resume
            // with `finishRoom` instead of creating another room on retry
            err.roomId = roomId;
            err.roomSetup = {name, topic, isPublic};
            throw err;
        }
        return roomId;
    }

    /**
     * Finish setting up a room whose create event was already accepted, or
     * resume an earlier `createRoom` that failed partway. The transaction IDs
     * are derived from the room ID, so a retry resends the same signed events.
     */
    async finishRoom(roomId, {name, topic, isPublic = false, log} = {}) {
        await this._finishRoom(roomId, {name, topic, isPublic}, log);
        return roomId;
    }

    /** Join, set the join rule and the optional name and topic, idempotently. */
    async _finishRoom(roomId, {name, topic, isPublic}, log) {
        await this._join(roomId, log, undefined, `cygnus-create-${roomId}-join`);
        await this._signer.send({
            roomId,
            type: "m.room.join_rules",
            stateKey: "",
            content: {join_rule: isPublic ? "public" : "invite"},
        }, {log, txnId: `cygnus-create-${roomId}-join-rules`});
        if (name) {
            await this._signer.send({roomId, type: "m.room.name", stateKey: "", content: {name}},
                {log, txnId: `cygnus-create-${roomId}-name`});
        }
        if (topic) {
            await this._signer.send({roomId, type: "m.room.topic", stateKey: "", content: {topic}},
                {log, txnId: `cygnus-create-${roomId}-topic`});
        }
    }

    /**
     * Join an existing Cygnus room with a device-signed membership event.
     * `via` names resident servers when the custodian is not yet in the room.
     */
    async joinRoom(roomId, {log, via} = {}) {
        await this._join(roomId, log, via);
        return roomId;
    }

    async rebindRoom(roomId, {log, via} = {}) {
        const txnId = `cygnus-rebind-${this._identity.rebindHeight}-${roomId}`;
        return this._join(roomId, log, via, txnId);
    }

    leaveRoom(roomId, {log, txnId = `cygnus-leave-${this._identity.height}-${roomId}`} = {}) {
        // the same transaction ID on retry resends the stored signed event instead of signing a second leave
        return this._signer.send({
            roomId,
            type: "m.room.member",
            stateKey: this._identity.principal,
            content: {membership: "leave", custodian: this._identity.custodian},
        }, {log, txnId});
    }

    async _join(roomId, log, via, txnId) {
        return this._signer.send({
            roomId,
            type: "m.room.member",
            stateKey: this._identity.principal,
            content: {membership: "join", custodian: this._identity.custodian},
            via,
        }, {log, txnId});
    }
}
