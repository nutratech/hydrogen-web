/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {CYGNUS_ROOM_VERSION} from "./constants.js";

/**
 * Room lifecycle for MSC00FC rooms, as the user-signed events a device sends.
 *
 * The epoch events between them (`m.room.user_epoch` and
 * `m.room.server_epoch` introductions and advancements) carry no device
 * signature (§5.2.1), so the custodian sends them. This class assumes the
 * custodian does that when it accepts a create or a join; the spec gives no
 * client endpoint to request them.
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
        return roomId;
    }

    /**
     * Join an existing Cygnus room with a device-signed membership event.
     * Spec gap: §7 has the joining server send the epoch introductions through
     * make_join/send_join, but no client-server call starts that for a room
     * the user is not in yet; this relies on `event_draft` doing so.
     */
    async joinRoom(roomId, {log} = {}) {
        await this._join(roomId, log);
        return roomId;
    }

    async _join(roomId, log) {
        return this._signer.send({
            roomId,
            type: "m.room.member",
            stateKey: this._identity.principal,
            content: {membership: "join", custodian: this._identity.custodian},
        }, {log});
    }
}
