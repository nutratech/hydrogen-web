/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {RoomRouter} from "./RoomRouter.js";
import {LoadStatus} from "../Client.js";
import {SyncStatus} from "../Sync.js";

function isTokenRejected(error) {
    return error?.errcode === "M_UNKNOWN_TOKEN";
}

export const ConnectionStatus = Object.freeze({
    Starting: "starting",
    Ready: "ready",
    Unavailable: "unavailable",
});

/**
 * The live sessions of one workspace, keyed by connection ID (step 5 of
 * doc/implementation planning/CYGNUS-WORKSPACE.md).
 *
 * Created when a workspace is opened, above `SessionViewModel`, because the
 * secondary connections arrive later than the source and may never arrive:
 * the source is shown as soon as it is ready, every other connection in the
 * record is started in the background, and one that cannot start is marked
 * unavailable without blocking the workspace. Its rooms then fail closed in
 * the router until it comes back.
 *
 * The source client stays owned by `SessionViewModel` (as before workspaces);
 * this object owns and disposes the secondary clients.
 */
export class WorkspaceConnections {
    /**
     * @param {object} options
     * @param {import("./WorkspaceStorage.js").Workspace} options.workspace
     * @param {import("./WorkspaceStorage.js").WorkspaceStorage} options.workspaceStorage
     * @param {{get(id: string): Promise<object | undefined>}} options.sessionInfoStorage
     * @param {object} options.sourceClient the loaded client of the source connection
     * @param {() => object} options.createClient a new, unstarted `Client`
     * @param {boolean} [options.newRoomsOnDestination] see `RoomRouter.newRoomConnectionId`
     */
    constructor({workspace, workspaceStorage, sessionInfoStorage, sourceClient, createClient, newRoomsOnDestination = false}) {
        this._workspaceStorage = workspaceStorage;
        this._sessionInfoStorage = sessionInfoStorage;
        this._createClient = createClient;
        this._sourceClient = sourceClient;
        this._sessions = new Map([[workspace.sourceConnectionId, sourceClient.session]]);
        this._clients = new Map();
        this._statuses = new Map([[workspace.sourceConnectionId, {status: ConnectionStatus.Ready}]]);
        this._listeners = new Set();
        this._claimSubscriptions = new Map();
        this._authSubscriptions = new Map();
        this._userIds = new Map();
        this._disposed = false;
        this.roomRouter = new RoomRouter({workspace, workspaceStorage, sessions: this._sessions, newRoomsOnDestination});
    }

    get workspace() {
        return this.roomRouter.workspace;
    }

    /** `{status, error, needsReauth}` for a connection; `undefined` for a connection this workspace does not have. */
    statusOf(connectionId) {
        return this._statuses.get(connectionId);
    }

    /**
     * Secondary connections that are not working, for the status bar:
     * `[{connectionId, userId, needsReauth, error}]`. Their rooms are
     * unavailable until they are back.
     */
    problems() {
        return [...this._statuses.entries()]
            .filter(([, s]) => s.status === ConnectionStatus.Unavailable)
            .map(([connectionId, s]) => ({connectionId, userId: this._userIds.get(connectionId),
                needsReauth: !!s.needsReauth, error: s.error}));
    }

    clientFor(connectionId) {
        return connectionId === this.workspace.sourceConnectionId ? this._sourceClient : this._clients.get(connectionId);
    }

    /** Call `listener` on any connection status change. Returns an unsubscribe function. */
    subscribe(listener) {
        this._listeners.add(listener);
        return () => { this._listeners.delete(listener); };
    }

    /**
     * Start every connection other than the source. Callers need not await
     * this: the returned promise settles once each connection is ready or
     * unavailable, and never rejects.
     */
    start() {
        const others = this.workspace.connections.filter(c => c.id !== this.workspace.sourceConnectionId);
        return Promise.all(others.map(c => this._restore(c)));
    }

    /**
     * Add a destination connection from fresh auth data and start it. The
     * workspace record is written first and the session info second (hidden
     * in its first write), so a reload in between leaves a connection without
     * session info, shown as unavailable, never a stray ordinary session.
     * Resolves to the new connection ID once it is ready; rejects if it fails.
     */
    async connectDestination(authData) {
        this._assertNotDisposed();
        const client = this._createClient();
        const sessionId = client.createNewSessionId();
        const {connectionId, workspace} = this._workspaceStorage.addConnection(this.workspace.id, {sessionId});
        this.roomRouter.updateWorkspace(workspace);
        this._clients.set(connectionId, client);
        this._userIds.set(connectionId, authData.userId);
        await this._run(connectionId, client, () => client.startHiddenWithAuthData(sessionId, authData));
        const {status, error} = this.statusOf(connectionId);
        if (status !== ConnectionStatus.Ready) {
            throw error ?? new Error(`connection ${connectionId} did not start`);
        }
        return connectionId;
    }

    async _restore(connection) {
        this._setStatus(connection.id, {status: ConnectionStatus.Starting});
        try {
            const sessionInfo = await this._sessionInfoStorage.get(connection.sessionId);
            if (!sessionInfo) {
                throw new Error(`connection ${connection.id} has no session ${connection.sessionId}`);
            }
            this._userIds.set(connection.id, sessionInfo.userId);
            if (this._disposed) {
                return;
            }
            const client = this._createClient();
            this._clients.set(connection.id, client);
            await this._run(connection.id, client, () => client.startWithExistingSession(connection.sessionId));
        } catch (error) {
            this._setStatus(connection.id, {status: ConnectionStatus.Unavailable, error});
        }
    }

    /**
     * Start `client` and settle when it is ready (its session joins the
     * router) or failed (the connection is unavailable). Does not wait for
     * the client's session start after the first sync.
     */
    _run(connectionId, client, start) {
        this._setStatus(connectionId, {status: ConnectionStatus.Starting});
        return new Promise(resolve => {
            let settled = false;
            const settle = () => {
                if (settled) {
                    return;
                }
                const status = client.loadStatus.get();
                if (status === LoadStatus.Ready) {
                    settled = true;
                    unsubscribe();
                    try {
                        if (!this._disposed) {
                            this._claimRoomsOf(connectionId, client.session);
                            this._watchAuth(connectionId, client);
                            this._sessions.set(connectionId, client.session);
                            this._setStatus(connectionId, {status: ConnectionStatus.Ready});
                            this.roomRouter.notifyChanged();
                        }
                    } catch (error) {
                        // never leave a connection starting forever
                        this._setStatus(connectionId, {status: ConnectionStatus.Unavailable, error});
                    }
                    resolve();
                } else if (status === LoadStatus.Error || status === LoadStatus.LoginFailed) {
                    settled = true;
                    unsubscribe();
                    const error = client.loadError ?? new Error(`connection ${connectionId} failed to load`);
                    this._setStatus(connectionId, {status: ConnectionStatus.Unavailable, error,
                        needsReauth: isTokenRejected(error)});
                    resolve();
                }
            };
            const unsubscribe = client.loadStatus.subscribe(settle);
            Promise.resolve().then(start).then(settle, error => {
                if (!settled) {
                    settled = true;
                    unsubscribe();
                    this._setStatus(connectionId, {status: ConnectionStatus.Unavailable, error});
                    resolve();
                }
            });
        });
    }

    _setStatus(connectionId, status) {
        if (this._disposed) {
            return;
        }
        if (status.status !== ConnectionStatus.Ready) {
            for (const subscriptions of [this._claimSubscriptions, this._authSubscriptions]) {
                subscriptions.get(connectionId)?.();
                subscriptions.delete(connectionId);
            }
            if (this._sessions.delete(connectionId)) {
                this.roomRouter.notifyChanged();
            }
        }
        this._statuses.set(connectionId, status);
        for (const listener of [...this._listeners]) {
            listener(connectionId, status);
        }
    }

    /**
     * Give a secondary connection the rooms and invites only it holds, now and
     * as they arrive (joined, created or invited there). A room the source
     * also holds stays the source's; see `RoomRouter.unclaimedRoomIds`.
     */
    _claimRoomsOf(connectionId, session) {
        const holds = roomId => !!(session.rooms.get(roomId) || session.invites.get(roomId));
        // runs inside the connection's sync (map events): never throw into it
        const guarded = (what, apply) => {
            try {
                apply();
            } catch (err) {
                console.error(`workspace: could not ${what} on connection ${connectionId}`, err);
            }
        };
        const claim = roomIds => guarded("claim rooms", () => {
            const unclaimed = this.roomRouter.unclaimedRoomIds(connectionId, roomIds);
            if (unclaimed.length) {
                this.roomRouter.claimRooms(unclaimed, connectionId);
            }
        });
        // a room this connection owns but no longer holds (invite rejected,
        // room left) goes back to the source, or the source's copy would stay hidden
        const release = roomIds => guarded("release rooms", () => {
            const released = roomIds.filter(roomId => this.workspace.ownerOf(roomId) === connectionId && !holds(roomId));
            if (released.length) {
                this.roomRouter.claimRooms(released, this.workspace.sourceConnectionId);
            }
        });
        release(this.workspace.roomsOwnedBy(connectionId));
        claim([...session.rooms.keys(), ...session.invites.keys()]);
        const handler = {
            onAdd: key => claim([key]),
            onUpdate() {},
            onRemove: key => release([key]),
            onReset() {},
        };
        const unsubscribes = [session.rooms.subscribe(handler), session.invites.subscribe(handler)];
        this._claimSubscriptions.set(connectionId, () => unsubscribes.forEach(unsubscribe => unsubscribe()));
    }

    /**
     * A secondary connection whose access token is rejected becomes
     * unavailable and asks for re-authentication. It is not the workspace
     * logging out: the source and its rooms keep working, and this
     * connection's rooms show as unavailable until it signs in again.
     * (The source's own token loss still goes through SessionViewModel's
     * forced logout.)
     */
    _watchAuth(connectionId, client) {
        const sync = client.sync;
        if (!sync) {
            return;
        }
        const unsubscribe = sync.status.subscribe(status => {
            if (status === SyncStatus.Stopped && isTokenRejected(sync.error)) {
                this._setStatus(connectionId, {status: ConnectionStatus.Unavailable, error: sync.error, needsReauth: true});
            }
        });
        this._authSubscriptions.set(connectionId, unsubscribe);
    }

    _assertNotDisposed() {
        if (this._disposed) {
            throw new Error("workspace connections are disposed");
        }
    }

    /** Stop and release every secondary client. The source client belongs to its view model. */
    dispose() {
        this._disposed = true;
        for (const subscriptions of [this._claimSubscriptions, this._authSubscriptions]) {
            for (const unsubscribe of subscriptions.values()) {
                unsubscribe();
            }
            subscriptions.clear();
        }
        for (const client of this._clients.values()) {
            client.dispose();
        }
        this._clients.clear();
        this._sessions.clear();
        this._listeners.clear();
    }
}
