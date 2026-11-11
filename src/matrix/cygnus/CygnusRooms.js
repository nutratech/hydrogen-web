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
            await this._join(roomId, log);
            await this._signer.send({
                roomId,
                type: "m.room.join_rules",
                stateKey: "",
                content: {join_rule: isPublic ? "public" : "invite"},
            }, {log});
            if (name) {
                await this._signer.send({roomId, type: "m.room.name", stateKey: "", content: {name}}, {log});
            }
            if (topic) {
                await this._signer.send({roomId, type: "m.room.topic", stateKey: "", content: {topic}}, {log});
            }
        } catch (err) {
            // the room exists now; let the caller finish it with `joinRoom` instead of creating another
            err.roomId = roomId;
            throw err;
        }
        return roomId;
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
