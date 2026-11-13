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
     * @param {boolean} [options.newRoomsOnDestination] see `newRoomConnectionId`
     */
    constructor({workspace, workspaceStorage, sessions, session, newRoomsOnDestination = false}) {
        this._workspace = workspace;
        this._workspaceStorage = workspaceStorage;
        // shared with WorkspaceConnections, which adds and removes sessions as connections come and go
        this._sessions = workspace ? (sessions ?? new Map()) : new Map([["single", session]]);
        this._newRoomsOnDestination = newRoomsOnDestination;
        this._listeners = new Set();
    }

    get workspace() {
        return this._workspace;
    }

    /** Replace the workspace record after another writer changed it (e.g. a connection was added). */
    updateWorkspace(workspace) {
        if (workspace.id !== this._workspace?.id) {
            throw new Error("a router serves one workspace");
        }
        this._workspace = workspace;
        this.notifyChanged();
    }

    /**
     * Call `listener` whenever a connection's session arrives or goes away, or
     * a room changes owner, so whatever routed a room can route it again.
     * Returns an unsubscribe function.
     */
    subscribeChanges(listener) {
        this._listeners.add(listener);
        return () => { this._listeners.delete(listener); };
    }

    notifyChanged() {
        for (const listener of [...this._listeners]) {
            listener();
        }
    }

    sessionForConnection(connectionId) {
        return this._sessions.get(connectionId);
    }

    /** `[connectionId, session]` for every live connection, the source first when it is live. */
    liveSessions() {
        const entries = [...this._sessions.entries()].filter(([, session]) => session);
        const sourceId = this._workspace?.sourceConnectionId;
        return entries.sort(([a], [b]) => (b === sourceId) - (a === sourceId));
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
     * Where new rooms are created and joined. The source, unless the
     * destination is allowed to take them (`newRoomsOnDestination`) and is live.
     *
     * Kept on the source by default: the destination account has no key
     * backup or secret storage of its own yet, so encrypted rooms created
     * there would have no recovery story. Cygnus rooms reach the destination
     * through the move, not through this.
     */
    get newRoomConnectionId() {
        if (!this._workspace) {
            return "single";
        }
        if (!this._newRoomsOnDestination) {
            return this._workspace.sourceConnectionId;
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
     * Record that `connectionId` owns `roomId`. Without this a room only the
     * destination sees would route to the source after a reload. Owning by the
     * source keeps the map sparse. Source-held rooms are reclaimed on arrival.
     */
    claimRoom(roomId, connectionId) {
        this.claimRooms([roomId], connectionId);
    }

    /** `claimRoom` for several rooms in one write and one change notification. */
    claimRooms(roomIds, connectionId) {
        if (!this._workspace || !this._workspaceStorage) {
            return;
        }
        const changed = roomIds.filter(roomId => this._workspace.ownerOf(roomId) !== connectionId);
        // Write even when the cached record already names this owner: another tab may
        // have changed it, and the write refreshes this router's snapshot.
        this._workspace = this._workspaceStorage.setRoomOwners(this._workspace.id, roomIds, connectionId);
        if (changed.length) {
            this.notifyChanged();
        }
    }

    /**
     * The rooms and invites `connectionId` holds that should be its own: those
     * the source connection does not also hold. A room both accounts are in
     * stays with the source, so joining it from the destination neither shows
     * it twice nor flips its owner. Used for joins, creations and invites alike.
     */
    unclaimedRoomIds(connectionId, roomIds) {
        if (!this._workspace || connectionId === this._workspace.sourceConnectionId) {
            return [];
        }
        const source = this.sessionForConnection(this._workspace.sourceConnectionId);
        return roomIds.filter(roomId => this._workspace.ownerOf(roomId) !== connectionId &&
            !source?.rooms.get(roomId) && !source?.invites.get(roomId));
    }
}
