/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/* global globalThis */

import {DmlsService, DMLS_EVENT_TYPES, dmlsCapability, readBlobSeq} from "./DmlsService.js";
import {CygnusVerifier} from "./CygnusVerifier.js";
import {createMockStorage} from "../../mocks/Storage";
import {webcrypto} from "node:crypto";

// OpenMLS's wasm backend reaches `getrandom`, which needs a global WebCrypto.
// Node 18 does not expose one by default.
if (!globalThis.crypto) {
    globalThis.crypto = webcrypto;
}

const ROUTE_ROOM = "!dmls-route:example.org";
const KEY_ROOM = "!dmls-key:example.org";
const CAS_ROOM = "!dmls-cas:example.org";
const ALICE = "@dI_Nb8pazMUMAWyJ4zMFDtJnftNKYwQu2puGEkPBcKY";
const BOB = "@AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ALICE_SEED = "ISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISE";
const BOB_SEED = "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI";
const UNKNOWN_GROUP = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function identity(principal, deviceId, deviceSeed) {
    return {principal, deviceId, deviceSeed, isRetired: false, isHandoffPending: false};
}

function captureSends() {
    const sent = [];
    const toDevice = [];
    return {
        sent,
        toDevice,
        sendEvent: async (roomId, type, content) => {
            const eventId = `$e${sent.length + 1}`;
            sent.push({roomId, type, content, eventId});
            return eventId;
        },
        sendToDevice: async (type, payload) => {
            toDevice.push({type, payload});
        },
    };
}

async function loadWasm() {
    const {readFile} = await import("node:fs/promises");
    await new CygnusVerifier().load(await readFile(
        new URL("./wasm/cygnus_wasm_bg.wasm", import.meta.url)));
}

async function makeService(storage, who, capture) {
    return new DmlsService({
        storage,
        getIdentity: () => who,
        subtleCrypto: webcrypto.subtle,
        getRandomValues: bytes => webcrypto.getRandomValues(bytes),
        sendEvent: capture.sendEvent,
        sendToDevice: capture.sendToDevice,
    });
}

async function groupRecord(storage, groupId) {
    const txn = await storage.readTxn([storage.storeNames.dmlsGroups]);
    return txn.dmlsGroups.get(groupId);
}

export function tests() {
    return {
        "capability requires a supported DMLS block on a Cygnus room": assert => {
            const create = {
                room_version: "tk.nutra.cygnus.12",
                "tk.nutra.cygnus.dmls": {version: 1, ciphersuite: "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519"},
            };
            assert.equal(dmlsCapability(create).capable, true);
            assert.equal(dmlsCapability({room_version: "tk.nutra.cygnus.12"}).reason, "absent");
            assert.equal(dmlsCapability({room_version: "12"}).reason, "not_cygnus");
            assert.equal(dmlsCapability({
                room_version: "tk.nutra.cygnus.12",
                "tk.nutra.cygnus.dmls": {version: 2},
            }).reason, "unsupported_version");
            assert.equal(dmlsCapability({
                room_version: "tk.nutra.cygnus.12",
                "tk.nutra.cygnus.dmls": {version: 1, ciphersuite: "other"},
            }).reason, "unsupported_ciphersuite");
        },

        "reads the version-1 blob sequence number": assert => {
            const bytes = new Uint8Array(14);
            bytes.set([0x43, 0x59, 0x44, 0x4d]);
            new DataView(bytes.buffer).setUint16(4, 1);
            new DataView(bytes.buffer).setBigUint64(6, 42n);
            let binary = "";
            for (const byte of bytes) {
                binary += String.fromCharCode(byte);
            }
            const b64 = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
            assert.equal(readBlobSeq(b64), 42);
            assert.throws(() => readBlobSeq("AAAA"));
        },

        "persists encrypted group state and routes a received commit": async assert => {
            await loadWasm();
            const storage = await createMockStorage();
            const sends = captureSends();
            const alice = identity(ALICE, "A1", ALICE_SEED);
            const service = await makeService(storage, alice, sends);

            const created = await service.createGroup(ROUTE_ROOM);
            const groupId = created.groupId;
            const stored = await groupRecord(storage, groupId);
            assert.equal(stored.seq, 1);
            assert.equal(stored.roomId, ROUTE_ROOM);
            assert.equal(typeof stored.blob.ct, "string");
            assert.equal(JSON.stringify(stored).includes(created.stateB64), false);

            // The first Commit is on the genesis state.
            const commit = await service.sendCommit(ROUTE_ROOM, '{"op":"self_update"}', undefined);
            assert.equal(commit.eventType, DMLS_EVENT_TYPES.commit);
            assert.equal(sends.sent.length, 1);
            assert.equal(sends.sent[0].roomId, ROUTE_ROOM);
            const afterCommit = await groupRecord(storage, groupId);
            assert.equal(afterCommit.seq, 2);

            // Re-applying our own event is routed by type and idempotent.
            const applied = await service.handleRoomEvent(ROUTE_ROOM, {
                type: DMLS_EVENT_TYPES.commit,
                sender: ALICE,
                device_certificate: {device_id: "A1"},
                prev_events: ["$e1"],
                content: commit.content,
            });
            assert.equal(applied.status, "applied");
            assert.equal((await groupRecord(storage, groupId)).seq, 2);

            // A non-protocol event is not ours.
            assert.equal(await service.handleRoomEvent(ROUTE_ROOM, {type: "m.room.message"}), undefined);

            // A reboot naming a group we do not hold defers.
            const reboot = await service.handleRoomEvent(ROUTE_ROOM, {
                type: DMLS_EVENT_TYPES.reboot,
                sender: ALICE,
                device_certificate: {device_id: "A1"},
                prev_events: ["$e1"],
                content: {old_group_id: UNKNOWN_GROUP, reason: "state-loss", members: [], base: {}},
            });
            assert.equal(reboot.status, "deferred");
            assert.equal(reboot.reason, "missing_base_state");
        },

        "stores key-package secrets encrypted and writes them before publishing": async assert => {
            await loadWasm();
            const storage = await createMockStorage();
            const sends = captureSends();
            const service = await makeService(storage, identity(BOB, "B1", BOB_SEED), sends);
            const out = await service.keyPackage(KEY_ROOM);
            const txn = await storage.readTxn([storage.storeNames.dmlsKeyPackages]);
            const stored = await txn.dmlsKeyPackages.get(out.keyPackageId);
            assert.equal(stored.roomId, KEY_ROOM);
            assert.equal(typeof stored.secret.ct, "string");
            assert.equal(JSON.stringify(stored).includes(out.secretsB64), false);
            assert.equal(sends.sent.length, 0);

            await service.publishKeyPackage(KEY_ROOM);
            assert.equal(sends.sent.length, 1);
            assert.equal(sends.sent[0].type, DMLS_EVENT_TYPES.keyPackage);

            // A Welcome for a package we do not own is a protocol status.
            const joined = await service.handleToDevice({
                type: DMLS_EVENT_TYPES.welcome,
                content: {group_id: UNKNOWN_GROUP, key_package_id: UNKNOWN_GROUP},
            });
            assert.equal(joined.status, "wrong_key_package");
        },

        "refuses a stored record whose blob sequence was changed": async assert => {
            await loadWasm();
            const storage = await createMockStorage();
            const service = await makeService(
                storage, identity(ALICE, "A1", ALICE_SEED), captureSends());
            const {groupId} = await service.createGroup(CAS_ROOM);
            const record = await groupRecord(storage, groupId);
            const txn = await storage.readWriteTxn([storage.storeNames.dmlsGroups]);
            txn.dmlsGroups.set({...record, seq: record.seq + 5});
            await txn.complete();
            await assert.rejects(
                service.sendCommit(CAS_ROOM, '{"op":"self_update"}', undefined),
                /bad_state: blob seq does not match its record/,
            );
        },
    };
}
