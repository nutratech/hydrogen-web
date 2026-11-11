/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/**
 * Picks the session that owns a room (step 4 of the workspace design).
 *
 * Rooms, invites and rooms being created already carry their own session,
 * homeserver and media repository, so choosing the right object is the whole
 * of routing: sending, receipts, typing, invites, leaving and media follow from
 * it. This class only chooses.
 *
 * `Workspace` stays plain data; the live sessions are held here, keyed by
 * connection ID. Lookups fail closed: if the owning connection has no live
 * session, the answer is `undefined`, never the source session, which would
 * show a stale copy of a room the source no longer owns.
 */
export class RoomRouter {
    /**
     * @param {object} options
     * @param {import("./WorkspaceStorage.js").Workspace} [options.workspace]
     * @param {import("./WorkspaceStorage.js").WorkspaceStorage} [options.workspaceStorage]
     * @param {Map<string, object>} [options.sessions] connection ID → Session
     * @param {object} [options.session] the only session, when there is no workspace
     */
    constructor({workspace, workspaceStorage, sessions, session}) {
        this._workspace = workspace;
        this._workspaceStorage = workspaceStorage;
        this._sessions = workspace ? (sessions ?? new Map()) : new Map([["single", session]]);
    }

    get workspace() {
        return this._workspace;
    }

    sessionForConnection(connectionId) {
        return this._sessions.get(connectionId);
    }

    /** The connection that owns `roomId`. */
    ownerOf(roomId) {
        return this._workspace ? this._workspace.ownerOf(roomId) : "single";
    }

    /** The owning connection's session, or `undefined` while that connection is unavailable. */
    sessionForRoom(roomId) {
        return this.sessionForConnection(this.ownerOf(roomId));
    }

    /**
     * Where new rooms are created and joined: the destination connection once
     * it is live, otherwise the source.
     */
    get newRoomConnectionId() {
        if (!this._workspace) {
            return "single";
        }
        const destination = this._workspace.connections.find(c => c.role === "destination" && this._sessions.has(c.id));
        return destination?.id ?? this._workspace.sourceConnectionId;
    }

    sessionForNewRooms() {
        return this.sessionForConnection(this.newRoomConnectionId);
    }

    /**
     * The session holding a room being created. Its local ID is not a room ID,
     * so it has no owner yet; ask every live session.
     */
    sessionForLocalId(localId) {
        for (const session of this._sessions.values()) {
            if (session?.roomsBeingCreated?.get(localId)) {
                return session;
            }
        }
        return undefined;
    }

    /**
     * Record that `connectionId` owns `roomId`, after creating or joining it
     * there. Without this a room only the destination sees would route to the
     * source after a reload. Owning by the source keeps the map sparse.
     */
    claimRoom(roomId, connectionId) {
        if (!this._workspace || !this._workspaceStorage) {
            return;
        }
        if (this._workspace.ownerOf(roomId) === connectionId) {
            return;
        }
        this._workspace = this._workspaceStorage.setRoomOwner(this._workspace.id, roomId, connectionId);
    }
}
