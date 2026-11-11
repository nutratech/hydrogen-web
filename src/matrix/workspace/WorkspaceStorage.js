/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/**
 * Workspaces: what the user sees as one session, backed by one or more Matrix
 * account connections (see doc/implementation planning/CYGNUS-WORKSPACE.md).
 *
 * The records live beside the session list, never in an account's database,
 * so retiring or logging out one connection cannot lose the room ownership of
 * the others. Shape, under `hydrogen_workspaces_v1`:
 *
 *     {version: 1, workspaces: {[workspaceId]: {
 *         id, sourceConnectionId,
 *         connections: [{id, role: "source" | "destination", sessionId}],
 *         rooms: {[roomId]: connectionId},   // sparse: only non-source owners
 *     }}}
 *
 * A connection ID is not a session ID: re-authenticating an account creates a
 * new session, and only `connections[i].sessionId` changes; every room keeps
 * pointing at the same connection.
 *
 * Every mutation reads and writes the backing store synchronously, so within a
 * tab no other mutation can interleave (the read-modify-write races in
 * `SessionInfoStorage` come from awaiting between the two). Across tabs the
 * last write wins.
 */

export const WORKSPACES_STORAGE_KEY = "hydrogen_workspaces_v1";
const VERSION = 1;

/**
 * Sessions that belong to a workspace as a secondary connection are not listed
 * on their own. A hidden session that no workspace references (the two stores
 * drifted, e.g. a workspace was removed but its session info was not) is shown
 * again, so the user can still open or log out of it.
 */
export function isVisibleSessionInfo(sessionInfo, workspaceStorage) {
    if (!sessionInfo?.hidden) {
        return true;
    }
    return !workspaceStorage?.forSession(sessionInfo.id);
}

function isValidRecord(id, record) {
    return record?.id === id &&
        typeof record.sourceConnectionId === "string" &&
        Array.isArray(record.connections) &&
        record.connections.every(c => typeof c?.id === "string" &&
            (c.role === "source" || c.role === "destination") && typeof c.sessionId === "string") &&
        record.connections.some(c => c.id === record.sourceConnectionId && c.role === "source") &&
        record.rooms !== null && typeof record.rooms === "object" && !Array.isArray(record.rooms) &&
        Object.values(record.rooms).every(owner => record.connections.some(c => c.id === owner));
}

export class Workspace {
    constructor(record) {
        this._record = record;
    }

    get id() { return this._record.id; }
    get sourceConnectionId() { return this._record.sourceConnectionId; }
    get connections() { return this._record.connections.map(c => ({...c})); }

    connection(connectionId) {
        const connection = this._record.connections.find(c => c.id === connectionId);
        return connection ? {...connection} : undefined;
    }

    connectionForSession(sessionId) {
        const connection = this._record.connections.find(c => c.sessionId === sessionId);
        return connection ? {...connection} : undefined;
    }

    /** The connection that owns `roomId`: an explicit owner, or the source connection. */
    ownerOf(roomId) {
        return this._record.rooms[roomId] ?? this._record.sourceConnectionId;
    }

    /** The rooms explicitly owned by `connectionId` (the source's rooms are implicit). */
    roomsOwnedBy(connectionId) {
        return Object.entries(this._record.rooms).filter(([, owner]) => owner === connectionId).map(([roomId]) => roomId);
    }

    get sourceSessionId() {
        return this.connection(this.sourceConnectionId)?.sessionId;
    }
}

export class WorkspaceStorage {
    /**
     * @param {string} name the storage key
     * @param {{getItem(key: string): string | null, setItem(key: string, value: string): void}} backing
     *     `localStorage` in the app; any object with the same two methods in tests
     * @param {() => string} createId random ID generator
     */
    constructor(name, backing, createId) {
        this._name = name;
        this._backing = backing;
        this._createId = createId;
    }

    getAll() {
        return Object.values(this._read().workspaces).map(record => new Workspace(record));
    }

    get(workspaceId) {
        const record = this._read().workspaces[workspaceId];
        return record ? new Workspace(record) : undefined;
    }

    /** The workspace with a connection for this session, if any. */
    forSession(sessionId) {
        const record = Object.values(this._read().workspaces)
            .find(r => r.connections.some(c => c.sessionId === sessionId));
        return record ? new Workspace(record) : undefined;
    }

    /**
     * The session's workspace, creating one with the session as its source
     * connection the first time a session is opened. Idempotent; call it when
     * opening a session, never when only listing them.
     */
    ensureForSession(sessionId) {
        if (!sessionId) {
            throw new TypeError("a session ID is required");
        }
        return this._mutate(data => {
            const existing = Object.values(data.workspaces)
                .find(r => r.connections.some(c => c.sessionId === sessionId));
            if (existing) {
                return existing;
            }
            const connectionId = this._createId();
            const record = {
                id: this._createId(),
                sourceConnectionId: connectionId,
                connections: [{id: connectionId, role: "source", sessionId}],
                rooms: {},
            };
            data.workspaces[record.id] = record;
            return record;
        });
    }

    /** Record which connection owns a room. Owning by the source connection removes the override. */
    setRoomOwner(workspaceId, roomId, connectionId) {
        return this.setRoomOwners(workspaceId, [roomId], connectionId);
    }

    /** `setRoomOwner` for several rooms in one write. */
    setRoomOwners(workspaceId, roomIds, connectionId) {
        return this._mutateWorkspace(workspaceId, record => {
            if (!record.connections.some(c => c.id === connectionId)) {
                throw new Error(`workspace ${workspaceId} has no connection ${connectionId}`);
            }
            for (const roomId of roomIds) {
                if (connectionId === record.sourceConnectionId) {
                    delete record.rooms[roomId];
                } else {
                    record.rooms[roomId] = connectionId;
                }
            }
        });
    }

    /**
     * Add a destination connection for `sessionId`. Call this before the
     * session info exists, so that session is never seen without its workspace.
     * Returns the new connection's ID and the updated workspace.
     */
    addConnection(workspaceId, {role = "destination", sessionId}) {
        if (role !== "destination" || !sessionId) {
            throw new TypeError("a destination connection needs a session ID");
        }
        let connectionId;
        const workspace = this._mutate(data => {
            const record = data.workspaces[workspaceId];
            if (!record) {
                throw new Error(`no workspace ${workspaceId}`);
            }
            if (Object.values(data.workspaces).some(r => r.connections.some(c => c.sessionId === sessionId))) {
                throw new Error(`session ${sessionId} already has a connection`);
            }
            connectionId = this._createId();
            record.connections.push({id: connectionId, role, sessionId});
            return record;
        });
        return {connectionId, workspace};
    }

    /** Point a connection at a new session, e.g. after re-authenticating its account. */
    setConnectionSession(workspaceId, connectionId, sessionId) {
        if (typeof sessionId !== "string" || !sessionId) {
            throw new TypeError("a session ID is required");
        }
        return this._mutateWorkspace(workspaceId, record => {
            const connection = record.connections.find(c => c.id === connectionId);
            if (!connection) {
                throw new Error(`workspace ${workspaceId} has no connection ${connectionId}`);
            }
            connection.sessionId = sessionId;
        });
    }

    _mutateWorkspace(workspaceId, mutate) {
        return this._mutate(data => {
            const record = data.workspaces[workspaceId];
            if (!record) {
                throw new Error(`no workspace ${workspaceId}`);
            }
            mutate(record);
            return record;
        });
    }

    /** Read, mutate and write in one synchronous step; returns the mutated record as a `Workspace`. */
    _mutate(mutate) {
        const data = this._read();
        const record = mutate(data);
        this._backing.setItem(this._name, JSON.stringify(data));
        return new Workspace(JSON.parse(JSON.stringify(record)));
    }

    /**
     * Throws on unreadable or newer data rather than starting empty: the next
     * write would otherwise replace every workspace and its room ownership.
     */
    _read() {
        const json = this._backing.getItem(this._name);
        if (!json) {
            return {version: VERSION, workspaces: {}};
        }
        const data = JSON.parse(json);
        if (data?.version !== VERSION || !data.workspaces || typeof data.workspaces !== "object") {
            throw new Error(`unsupported workspace storage (version ${data?.version})`);
        }
        for (const [id, record] of Object.entries(data.workspaces)) {
            if (!isValidRecord(id, record)) {
                throw new Error(`corrupt workspace record ${id}`);
            }
        }
        return data;
    }
}
