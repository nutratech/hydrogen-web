/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {RoomRouter} from "./RoomRouter.js";
import {WorkspaceStorage} from "./WorkspaceStorage.js";
import {RoomViewModelObservable} from "../../domain/session/RoomViewModelObservable.js";
import {ObservableValue} from "../../observable/value";
import {RoomStatus} from "../room/common";

function memoryBacking() {
    const items = new Map();
    return {items, getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, value)};
}

/** A session that holds room `!r` (tagged with `name`) and optionally a room being created. */
function fakeSession(name, {localId} = {}) {
    const rooms = new Map([["!r", {id: "!r", from: name}]]);
    return {
        name,
        rooms,
        invites: new Map(),
        roomsBeingCreated: new Map(localId ? [[localId, {id: localId, from: name}]] : []),
        observed: [],
        async observeRoomStatus(id) {
            this.observed.push(id);
            return new ObservableValue(RoomStatus.Joined);
        },
    };
}

/** A workspace with a source and a destination connection (the destination is step 5; added by hand here). */
function twoConnectionWorkspace() {
    const backing = memoryBacking();
    let next = 0;
    const workspaceStorage = new WorkspaceStorage("ws", backing, () => `id${next++}`);
    const created = workspaceStorage.ensureForSession("s-source");
    const record = JSON.parse(backing.items.get("ws"));
    record.workspaces[created.id].connections.push({id: "dest", role: "destination", sessionId: "s-dest"});
    backing.setItem("ws", JSON.stringify(record));
    return {workspaceStorage, workspace: workspaceStorage.get(created.id)};
}

export function tests() {
    return {
        "a room routes to its owner's session, defaulting to the source": assert => {
            const {workspace, workspaceStorage} = twoConnectionWorkspace();
            const source = fakeSession("source");
            const destination = fakeSession("destination");
            let router = new RoomRouter({workspace, workspaceStorage,
                sessions: new Map([[workspace.sourceConnectionId, source], ["dest", destination]])});
            assert.equal(router.sessionForRoom("!r").rooms.get("!r").from, "source");
            router.claimRoom("!r", "dest");
            assert.equal(router.sessionForRoom("!r").rooms.get("!r").from, "destination");
            // a fresh router over a re-read store keeps the owner
            router = new RoomRouter({workspace: workspaceStorage.get(workspace.id), workspaceStorage,
                sessions: new Map([[workspace.sourceConnectionId, source], ["dest", destination]])});
            assert.equal(router.sessionForRoom("!r"), destination);
        },
        "an owner with no live session fails closed instead of falling back to the source": assert => {
            const {workspace, workspaceStorage} = twoConnectionWorkspace();
            const source = fakeSession("source");
            workspaceStorage.setRoomOwner(workspace.id, "!r", "dest");
            const router = new RoomRouter({workspace: workspaceStorage.get(workspace.id), workspaceStorage,
                sessions: new Map([[workspace.sourceConnectionId, source]])});
            assert.equal(router.sessionForRoom("!r"), undefined);
            assert.equal(router.sessionForRoom("!other"), source);
        },
        "new rooms go to the destination once it is live, otherwise the source": assert => {
            const {workspace, workspaceStorage} = twoConnectionWorkspace();
            const source = fakeSession("source");
            const destination = fakeSession("destination");
            const sourceOnly = new RoomRouter({workspace, workspaceStorage,
                sessions: new Map([[workspace.sourceConnectionId, source]])});
            assert.equal(sourceOnly.sessionForNewRooms(), source);
            const both = new RoomRouter({workspace, workspaceStorage,
                sessions: new Map([[workspace.sourceConnectionId, source], ["dest", destination]])});
            assert.equal(both.newRoomConnectionId, "dest");
            assert.equal(both.sessionForNewRooms(), destination);
        },
        "a room being created is found by its local ID on whichever session holds it": assert => {
            const {workspace, workspaceStorage} = twoConnectionWorkspace();
            const source = fakeSession("source");
            const destination = fakeSession("destination", {localId: "local-1"});
            const router = new RoomRouter({workspace, workspaceStorage,
                sessions: new Map([[workspace.sourceConnectionId, source], ["dest", destination]])});
            assert.equal(router.sessionForLocalId("local-1"), destination);
            assert.equal(router.sessionForLocalId("local-2"), undefined);
        },
        "claiming a room for the source keeps the map sparse": assert => {
            const {workspace, workspaceStorage} = twoConnectionWorkspace();
            const router = new RoomRouter({workspace, workspaceStorage, sessions: new Map()});
            router.claimRoom("!r", "dest");
            router.claimRoom("!r", workspace.sourceConnectionId);
            assert.equal(workspaceStorage.get(workspace.id).ownerOf("!r"), workspace.sourceConnectionId);
        },
        "without a workspace every room routes to the one session": assert => {
            const session = fakeSession("only");
            const router = new RoomRouter({session});
            assert.equal(router.sessionForRoom("!r"), session);
            assert.equal(router.sessionForNewRooms(), session);
            router.claimRoom("!r", "anything");
        },
        "the room observable watches the owner's session status": async assert => {
            const {workspace, workspaceStorage} = twoConnectionWorkspace();
            const source = fakeSession("source");
            const destination = fakeSession("destination");
            workspaceStorage.setRoomOwner(workspace.id, "!r", "dest");
            const roomRouter = new RoomRouter({workspace: workspaceStorage.get(workspace.id), workspaceStorage,
                sessions: new Map([[workspace.sourceConnectionId, source], ["dest", destination]])});
            const created = [];
            const sessionViewModel = {roomRouter, _createRoomViewModelInstance: id => { created.push(id); return {id, dispose() {}}; }};
            const observable = new RoomViewModelObservable(sessionViewModel, "!r");
            await observable.initialize();
            assert.deepEqual(destination.observed, ["!r"]);
            assert.deepEqual(source.observed, []);
            assert.deepEqual(created, ["!r"]);
            observable.dispose();
        },
        "the room observable stays empty when the owner is unavailable": async assert => {
            const {workspace, workspaceStorage} = twoConnectionWorkspace();
            const source = fakeSession("source");
            workspaceStorage.setRoomOwner(workspace.id, "!r", "dest");
            const roomRouter = new RoomRouter({workspace: workspaceStorage.get(workspace.id), workspaceStorage,
                sessions: new Map([[workspace.sourceConnectionId, source]])});
            const observable = new RoomViewModelObservable({roomRouter}, "!r");
            await observable.initialize();
            assert.equal(observable.get(), null);
            assert.deepEqual(source.observed, []);
            observable.dispose();
        },
    };
}
