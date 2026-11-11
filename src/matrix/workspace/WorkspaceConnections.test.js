/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {WorkspaceConnections, ConnectionStatus} from "./WorkspaceConnections.js";
import {WorkspaceStorage, isVisibleSessionInfo} from "./WorkspaceStorage.js";
import {RoomViewModelObservable} from "../../domain/session/RoomViewModelObservable.js";
import {ObservableValue} from "../../observable/value";
import {LoadStatus} from "../Client.js";
import {RoomStatus} from "../room/common";

function memoryBacking() {
    const items = new Map();
    return {items, getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, value)};
}

function fakeSession(name) {
    return {
        name,
        rooms: new Map([["!r", {id: "!r", from: name}]]),
        invites: new Map(),
        roomsBeingCreated: new Map(),
        async observeRoomStatus() { return new ObservableValue(RoomStatus.Joined); },
    };
}

/**
 * A stand-in for `Client`. `outcome` is "ready", "error", or "pending" (stays
 * loading until `finish()`); hidden starts write their session info the way
 * `Client._createSessionAfterAuth` does.
 */
function fakeClient(name, {outcome = "ready", sessionInfos} = {}) {
    const client = {
        name,
        loadStatus: new ObservableValue(LoadStatus.NotLoading),
        loadError: null,
        session: null,
        disposed: false,
        started: null,
        createNewSessionId: () => `session-${name}`,
        finish(result = "ready") {
            if (result === "ready") {
                client.session = fakeSession(name);
                client.loadStatus.set(LoadStatus.Ready);
            } else {
                client.loadError = new Error(`${name} failed`);
                client.loadStatus.set(LoadStatus.Error);
            }
        },
        async startWithExistingSession(sessionId) {
            client.started = {existing: sessionId};
            client.loadStatus.set(LoadStatus.Loading);
            if (outcome !== "pending") {
                client.finish(outcome);
            }
        },
        async startHiddenWithAuthData(sessionId, authData) {
            client.started = {hidden: sessionId, authData};
            sessionInfos?.set(sessionId, {id: sessionId, hidden: true, deviceId: authData.deviceId});
            client.loadStatus.set(LoadStatus.Loading);
            if (outcome !== "pending") {
                client.finish(outcome);
            }
        },
        dispose() { client.disposed = true; },
    };
    return client;
}

function setup({destinationSessionInfo = true, clientOptions = {}} = {}) {
    let next = 0;
    const workspaceStorage = new WorkspaceStorage("ws", memoryBacking(), () => `id${next++}`);
    let workspace = workspaceStorage.ensureForSession("s-source");
    const sessionInfos = new Map([["s-source", {id: "s-source"}]]);
    const sessionInfoStorage = {get: async id => sessionInfos.get(id), getAll: async () => [...sessionInfos.values()]};
    const source = fakeClient("source");
    source.finish();
    const created = [];
    const createClient = () => {
        const client = fakeClient(`c${created.length}`, {sessionInfos, ...clientOptions});
        created.push(client);
        return client;
    };
    return {
        workspaceStorage, sessionInfos, sessionInfoStorage, source, created, createClient,
        addDestination() {
            const {connectionId} = workspaceStorage.addConnection(workspace.id, {sessionId: "s-dest"});
            if (destinationSessionInfo) {
                sessionInfos.set("s-dest", {id: "s-dest", hidden: true});
            }
            workspace = workspaceStorage.get(workspace.id);
            return connectionId;
        },
        connections() {
            return new WorkspaceConnections({workspace, workspaceStorage, sessionInfoStorage, sourceClient: source, createClient});
        },
    };
}

export function tests() {
    return {
        "reopening a workspace restores its destination connection": async assert => {
            const env = setup();
            const dest = env.addDestination();
            const connections = env.connections();
            assert.equal(connections.roomRouter.sessionForConnection(dest), undefined);
            await connections.start();
            assert.equal(connections.statusOf(dest).status, ConnectionStatus.Ready);
            assert.deepEqual(env.created[0].started, {existing: "s-dest"});
            assert.equal(connections.roomRouter.sessionForConnection(dest).name, "c0");
            assert.equal(connections.roomRouter.sessionForConnection(connections.workspace.sourceConnectionId).name, "source");
        },
        "a connection without session info is unavailable and starts no client": async assert => {
            const env = setup({destinationSessionInfo: false});
            const dest = env.addDestination();
            const connections = env.connections();
            await connections.start();
            assert.equal(connections.statusOf(dest).status, ConnectionStatus.Unavailable);
            assert.match(connections.statusOf(dest).error.message, /has no session s-dest/);
            assert.equal(env.created.length, 0);
        },
        "a destination that fails leaves the source working and new rooms on the source": async assert => {
            const env = setup({clientOptions: {outcome: "error"}});
            const dest = env.addDestination();
            const connections = env.connections();
            await connections.start();
            assert.equal(connections.statusOf(dest).status, ConnectionStatus.Unavailable);
            assert.equal(connections.roomRouter.sessionForRoom("!r").name, "source");
            assert.equal(connections.roomRouter.sessionForNewRooms().name, "source");
        },
        "new rooms stay on the source while the destination gate is closed": async assert => {
            const env = setup();
            const dest = env.addDestination();
            const connections = env.connections();
            await connections.start();
            assert.equal(connections.statusOf(dest).status, ConnectionStatus.Ready);
            assert.equal(connections.roomRouter.newRoomConnectionId, connections.workspace.sourceConnectionId);
        },
        "connecting a destination records it before its hidden session info": async assert => {
            const env = setup();
            const connections = env.connections();
            const authData = {deviceId: "DEV", userId: "@a:new", accessToken: "t", homeserver: "https://new"};
            const dest = await connections.connectDestination(authData);
            const client = env.created[0];
            assert.deepEqual(client.started, {hidden: "session-c0", authData});
            assert.equal(env.workspaceStorage.forSession("session-c0").id, connections.workspace.id);
            assert.equal(connections.workspace.connection(dest).sessionId, "session-c0");
            const info = env.sessionInfos.get("session-c0");
            assert.equal(isVisibleSessionInfo(info, env.workspaceStorage), false);
            // opening the workspace again never makes a second one for the hidden session
            assert.equal(env.workspaceStorage.getAll().length, 1);
        },
        "a failed destination connection rejects": async assert => {
            const env = setup({clientOptions: {outcome: "error"}});
            const connections = env.connections();
            await assert.rejects(connections.connectDestination({deviceId: "DEV"}), /c0 failed/);
        },
        "disposing stops every secondary client and ignores late arrivals": async assert => {
            const env = setup({clientOptions: {outcome: "pending"}});
            const dest = env.addDestination();
            const connections = env.connections();
            const started = connections.start();
            await Promise.resolve();
            await Promise.resolve();
            connections.dispose();
            const client = env.created[0];
            assert.equal(client.disposed, true);
            assert.equal(env.source.disposed, false);
            client.finish();
            await started;
            assert.equal(connections.roomRouter.sessionForConnection(dest), undefined);
        },
        "a room shown as unavailable opens once its owner connects": async assert => {
            const env = setup({clientOptions: {outcome: "pending"}});
            const dest = env.addDestination();
            const connections = env.connections();
            connections.roomRouter.claimRoom("!r", dest);
            const created = [];
            const sessionViewModel = {
                roomRouter: connections.roomRouter,
                _createUnavailableRoomViewModel: id => ({kind: "unavailable", id, dispose() {}}),
                _createRoomViewModelInstance: id => { created.push(id); return {kind: "room", id, dispose() {}}; },
            };
            const observable = new RoomViewModelObservable(sessionViewModel, "!r");
            await observable.initialize();
            assert.equal(observable.get().kind, "unavailable");
            const started = connections.start();
            await Promise.resolve();
            await Promise.resolve();
            env.created[0].finish();
            await started;
            // initialize runs again on the session's arrival
            for (let i = 0; i < 5; i++) {
                await Promise.resolve();
            }
            assert.equal(observable.get().kind, "room");
            assert.deepEqual(created, ["!r"]);
            observable.dispose();
        },
    };
}
