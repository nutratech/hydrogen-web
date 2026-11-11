/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {WorkspaceStorage, isVisibleSessionInfo} from "./WorkspaceStorage.js";

/** A plain stand-in for `localStorage`; the Node test runner has none. */
function memoryBacking(initial = {}) {
    const items = new Map(Object.entries(initial));
    return {items, getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, value)};
}

function storage(backing = memoryBacking()) {
    let next = 0;
    return new WorkspaceStorage("ws", backing, () => `id${next++}`);
}

export function tests() {
    return {
        "opening a session creates its workspace once": assert => {
            const workspaces = storage();
            const first = workspaces.ensureForSession("s1");
            const again = workspaces.ensureForSession("s1");
            assert.equal(again.id, first.id);
            assert.equal(workspaces.getAll().length, 1);
            assert.equal(first.sourceSessionId, "s1");
            assert.equal(first.connections[0].role, "source");
            assert.notEqual(first.sourceConnectionId, "s1");
        },
        "two existing sessions get two workspaces": assert => {
            const workspaces = storage();
            const a = workspaces.ensureForSession("s1");
            const b = workspaces.ensureForSession("s2");
            assert.notEqual(a.id, b.id);
            assert.equal(workspaces.forSession("s2").id, b.id);
            assert.equal(workspaces.forSession("s3"), undefined);
        },
        "rooms default to the source connection": assert => {
            const workspace = storage().ensureForSession("s1");
            assert.equal(workspace.ownerOf("!any"), workspace.sourceConnectionId);
        },
        "an explicit owner survives the connection's session changing": assert => {
            const backing = memoryBacking();
            const workspaces = storage(backing);
            let workspace = workspaces.ensureForSession("s1");
            const record = JSON.parse(backing.items.get("ws"));
            record.workspaces[workspace.id].connections.push({id: "dest", role: "destination", sessionId: "s2"});
            backing.setItem("ws", JSON.stringify(record));
            workspaces.setRoomOwner(workspace.id, "!moved", "dest");
            workspace = workspaces.setConnectionSession(workspace.id, "dest", "s3");
            assert.equal(workspace.ownerOf("!moved"), "dest");
            assert.equal(workspace.connection("dest").sessionId, "s3");
            assert.equal(workspaces.forSession("s3").id, workspace.id);
            assert.equal(workspaces.forSession("s2"), undefined);
        },
        "ownership stays sparse": assert => {
            const backing = memoryBacking();
            const workspaces = storage(backing);
            const workspace = workspaces.ensureForSession("s1");
            const updated = workspaces.setRoomOwner(workspace.id, "!room", workspace.sourceConnectionId);
            assert.deepEqual(JSON.parse(backing.items.get("ws")).workspaces[workspace.id].rooms, {});
            assert.equal(updated.ownerOf("!room"), workspace.sourceConnectionId);
            assert.throws(() => workspaces.setRoomOwner(workspace.id, "!room", "nope"), /no connection nope/);
        },
        "unreadable or newer data is refused, not overwritten": assert => {
            const newer = JSON.stringify({version: 2, workspaces: {}});
            const backing = memoryBacking({ws: newer});
            assert.throws(() => storage(backing).ensureForSession("s1"), /unsupported workspace storage/);
            assert.equal(backing.items.get("ws"), newer);
        },
        "hidden sessions are not listed unless no workspace references them": assert => {
            const backing = memoryBacking();
            const workspaces = storage(backing);
            const workspace = workspaces.ensureForSession("s1");
            const record = JSON.parse(backing.items.get("ws"));
            record.workspaces[workspace.id].connections.push({id: "dest", role: "destination", sessionId: "s2"});
            backing.setItem("ws", JSON.stringify(record));
            assert.equal(isVisibleSessionInfo({id: "s1"}, workspaces), true);
            assert.equal(isVisibleSessionInfo({id: "s2", hidden: true}, workspaces), false);
            assert.equal(isVisibleSessionInfo({id: "orphan", hidden: true}, workspaces), true);
        },
        "a destination connection is added once, for an unused session": assert => {
            const workspaces = storage();
            const a = workspaces.ensureForSession("s1");
            workspaces.ensureForSession("s2");
            const {connectionId, workspace} = workspaces.addConnection(a.id, {sessionId: "s3"});
            assert.equal(workspace.connection(connectionId).role, "destination");
            assert.equal(workspaces.forSession("s3").id, a.id);
            assert.throws(() => workspaces.addConnection(a.id, {sessionId: "s3"}), /already has a connection/);
            assert.throws(() => workspaces.addConnection(a.id, {sessionId: "s2"}), /already has a connection/);
            assert.throws(() => workspaces.addConnection(a.id, {role: "source", sessionId: "s4"}), /destination/);
        },
        "a corrupt record is refused with a clear error": assert => {
            const corrupt = JSON.stringify({version: 1, workspaces: {x: {}}});
            const backing = memoryBacking({ws: corrupt});
            assert.throws(() => storage(backing).forSession("s1"), /corrupt workspace record x/);
            assert.throws(() => storage(backing).ensureForSession("s1"), /corrupt workspace record x/);
            assert.equal(backing.items.get("ws"), corrupt);
        },
    };
}
