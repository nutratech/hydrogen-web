/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {WorkspaceConnections, ConnectionStatus} from "./WorkspaceConnections.js";
import {WorkspaceStorage, isVisibleSessionInfo} from "./WorkspaceStorage.js";
import {RoomViewModelObservable} from "../../domain/session/RoomViewModelObservable.js";
import {ObservableValue} from "../../observable/value";
import {ObservableMap} from "../../observable";
import {LoadStatus} from "../Client.js";
import {SyncStatus} from "../Sync.js";
import {WorkspaceRoomMap} from "./WorkspaceRoomMap.js";
import {RoomStatus} from "../room/common";

function memoryBacking() {
    const items = new Map();
    return {items, getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, value)};
}

function fakeSession(name, {rooms = ["!r"], invites = []} = {}) {
    return {
        name,
        rooms: new ObservableMap(rooms.map(id => [id, {id, from: name}])),
        invites: new ObservableMap(invites.map(id => [id, {id, from: name, isInvite: true}])),
        roomsBeingCreated: new Map(),
        async observeRoomStatus() { return new ObservableValue(RoomStatus.Joined); },
    };
}

/**
 * A stand-in for `Client`. `outcome` is "ready", "error", or "pending" (stays
 * loading until `finish()`); hidden starts write their session info the way
 * `Client._createSessionAfterAuth` does.
 */
function fakeClient(name, {outcome = "ready", sessionInfos, holds} = {}) {
    const client = {
        name,
        loadStatus: new ObservableValue(LoadStatus.NotLoading),
        loadError: null,
        session: null,
        sync: {status: new ObservableValue(SyncStatus.Syncing), error: null},
        disposed: false,
        started: null,
        createNewSessionId: () => `session-${name}`,
        finish(result = "ready") {
            if (result === "ready") {
                client.session = fakeSession(name, holds);
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

function setup({destinationSessionInfo = true, clientOptions = {}, sourceHolds} = {}) {
    let next = 0;
    const workspaceStorage = new WorkspaceStorage("ws", memoryBacking(), () => `id${next++}`);
    let workspace = workspaceStorage.ensureForSession("s-source");
    const sessionInfos = new Map([["s-source", {id: "s-source"}]]);
    const sessionInfoStorage = {get: async id => sessionInfos.get(id), getAll: async () => [...sessionInfos.values()]};
    const source = fakeClient("source", {holds: sourceHolds});
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
        "destination-only rooms and invites are claimed; rooms both accounts hold stay with the source": async assert => {
            const env = setup({
                sourceHolds: {rooms: ["!both", "!src"], invites: ["!inv-both"]},
                clientOptions: {holds: {rooms: ["!both", "!dst"], invites: ["!inv-both", "!inv-dst"]}},
            });
            const dest = env.addDestination();
            const connections = env.connections();
            await connections.start();
            const ws = connections.workspace;
            assert.equal(ws.ownerOf("!dst"), dest);
            assert.equal(ws.ownerOf("!inv-dst"), dest);
            assert.equal(ws.ownerOf("!both"), ws.sourceConnectionId);
            assert.equal(ws.ownerOf("!inv-both"), ws.sourceConnectionId);
            // a later invite or join on the destination is claimed as it arrives
            const destSession = connections.roomRouter.sessionForConnection(dest);
            destSession.invites.add("!later", {id: "!later", from: "c0"});
            destSession.rooms.add("!src", {id: "!src", from: "c0"});
            assert.equal(connections.workspace.ownerOf("!later"), dest);
            assert.equal(connections.workspace.ownerOf("!src"), ws.sourceConnectionId);
            // and survives a reload
            assert.equal(env.workspaceStorage.get(ws.id).ownerOf("!later"), dest);
        },
        "the merged room list shows each room once, from its owner, without resets": async assert => {
            const env = setup({
                sourceHolds: {rooms: ["!both", "!src"]},
                clientOptions: {outcome: "pending", holds: {rooms: ["!both", "!dst"]}},
            });
            env.addDestination();
            const connections = env.connections();
            const rooms = new WorkspaceRoomMap(connections.roomRouter, s => s.rooms);
            const events = [];
            const unsubscribe = rooms.subscribe({
                onAdd: (k, v) => events.push(`add ${k} ${v.from}`),
                onUpdate: (k) => events.push(`update ${k}`),
                onRemove: (k, v) => events.push(`remove ${k} ${v.from}`),
                onReset: () => events.push("reset"),
            });
            assert.deepEqual([...rooms].map(([k, v]) => `${k} ${v.from}`), ["!both source", "!src source"]);
            const started = connections.start();
            await Promise.resolve();
            await Promise.resolve();
            env.created[0].finish();
            await started;
            assert.deepEqual(events, ["add !dst c0"]);
            assert.deepEqual([...rooms].map(([k, v]) => `${k} ${v.from}`).sort(), ["!both source", "!dst c0", "!src source"]);
            // an owner change moves the room's entry to the new owner's object
            events.length = 0;
            connections.roomRouter.claimRoom("!both", connections.workspace.connections[1].id);
            assert.deepEqual(events, ["remove !both source", "add !both c0"]);
            // a destination becoming unavailable takes its rooms out of the list
            events.length = 0;
            connections._setStatus(connections.workspace.connections[1].id, {status: ConnectionStatus.Unavailable});
            assert.deepEqual(events.sort(), ["remove !both c0", "remove !dst c0"]);
            unsubscribe();
        },
        "an open room follows its owner to another connection": async assert => {
            const env = setup({sourceHolds: {rooms: ["!x"]}, clientOptions: {holds: {rooms: ["!x"]}}});
            const dest = env.addDestination();
            const connections = env.connections();
            await connections.start();
            const shown = [];
            const sessionViewModel = {
                roomRouter: connections.roomRouter,
                _createUnavailableRoomViewModel: id => ({kind: "unavailable", id, dispose() {}}),
                _createRoomViewModelInstance: id => {
                    const from = connections.roomRouter.sessionForRoom(id).name;
                    shown.push(from);
                    return {kind: "room", from, dispose() {}};
                },
            };
            const observable = new RoomViewModelObservable(sessionViewModel, "!x");
            await observable.initialize();
            connections.roomRouter.claimRoom("!x", dest);
            for (let i = 0; i < 5; i++) {
                await Promise.resolve();
            }
            assert.deepEqual(shown, ["source", "c0"]);
            assert.equal(observable.get().from, "c0");
            observable.dispose();
        },
        "a rejected destination token makes only that connection unavailable, asking to sign in again": async assert => {
            const env = setup({clientOptions: {holds: {rooms: ["!dst"]}}});
            const dest = env.addDestination();
            const connections = env.connections();
            await connections.start();
            assert.equal(connections.roomRouter.sessionForRoom("!dst").name, "c0");
            const client = env.created[0];
            client.sync.error = {errcode: "M_UNKNOWN_TOKEN"};
            client.sync.status.set(SyncStatus.Stopped);
            const status = connections.statusOf(dest);
            assert.equal(status.status, ConnectionStatus.Unavailable);
            assert.equal(status.needsReauth, true);
            assert.equal(connections.roomRouter.sessionForRoom("!dst"), undefined);
            assert.equal(connections.roomRouter.sessionForRoom("!r").name, "source");
            assert.equal(client.disposed, false);
        },
        "a destination stopping for another reason stays connected": async assert => {
            const env = setup();
            const dest = env.addDestination();
            const connections = env.connections();
            await connections.start();
            const client = env.created[0];
            client.sync.error = {name: "ConnectionError"};
            client.sync.status.set(SyncStatus.Stopped);
            assert.equal(connections.statusOf(dest).status, ConnectionStatus.Ready);
        },
    };
}
