/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {CygnusCrypto} from "./CygnusCrypto.js";
import {CygnusIdentity, IDENTITY_SESSION_KEY} from "./CygnusIdentity.js";
import {CygnusEventSigner, checkDraft, FLOORS_SESSION_KEY, signedEventKey} from "./CygnusEventSigner.js";
import {ConnectionError, HomeServerError} from "../error.js";
import {CygnusRooms} from "./CygnusRooms.js";
import {CYGNUS_ROOM_VERSION} from "./constants.js";
import anotherjson from "another-json";

const anotherJson = value => anotherjson.stringify(value);

// MSC00FC Appendix A (pid_vectors.json): Alice's master and rotation seeds,
// her genesis link minted by server A, and server A's chain (pid_pdu_vectors.json event 0).
const USR_MSK = "Ly8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8";
const USR_ROT_1 = "ISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISE";
const USR_ROT_2 = "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI";
const SELF_SIGNING = "MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM";
const U0 = "AQIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4kBxguvojRXkm6JtORb1xDcBb37XlTZ9vN8bcmesKPLKBFMfYYrXmaC8fTsASfePhgrlaw5LF0TpCGLi5_C29AW4ywZdB8K-CYGEq6Z_RPYo4lEci4Ilk3SOXOPVSphU7ABdAYWxpY2U6Y2hhdC5leGFtcGxlLm9yZw";
const USER_U = "@Cl5rPGgj2s7JHMwFxSEOHfFYM_K0PDpnhXEMYwMgQuo";
const SERVER_A = "~soEUx9hiteZoLx9OwBJ94-GCuVrDksXROkIYuLn8Lb0";
const SERVER_A_LINKS = [
    "AQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACn43blzT6rgsVNzZYO7Q2Rty6Gui6qDEtLT9KTxg_8UIqI4910CfGV_VLbLTy6XXLKZwm_HZQSG_N0iAG0D29cABBjaGF0LmV4YW1wbGUub3Jn2Q1TtCiz1ePkElNMfK781u9YMaFhnLO0hG8z6K_y2aSahTHRknkQ8MVLscIBbzf0LtD98Jfza5nXkVQuh_K0CQ",
    "AQGygRTH2GK15mgvH07AEn3j4YK5WsOSxdE6Qhi4ufwtvQAAAAAAAAABsoEUx9hiteZoLx9OwBJ94-GCuVrDksXROkIYuLn8Lb01Nmw5cTdJ5i-8iyk2_ucSDxdQdO6gPdbzTa9bC_blH-1JKMYo0cLG6ukDOJBZlWEpWSc6XGP5NjbBRhSshzfRABBjaGF0LmV4YW1wbGUub3JngTl3Dqh9F19Wo1Rmw0x-zMuNipG07jeiXfYPW4_Js5SxA7F2pH-iNJh8RCmwbClk188UfWoteisDrefjnO4Wcxjg6D_r5fzgWl4cY8xqkAxfEuhqoj3hZQxNf3P2ZfkK",
];
const SERVER_B_GENESIS = "AQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1X_O2HVJ_0X5Qxn2KAplUg_89nXNprGMHNy69KOtjdtBKsjJ0K7SrOhNovUYV5ObQIkq3GgFrr4UgozLJd4c3ABJzZWNvbmQuZXhhbXBsZS5uZXRRDEmMbnKpYv8QouxBnJrVvVlWT9cZ_Gi9Ode0mURfhnFMHqeE8qHdpX0CCZzeSq7MTuSJ7yTVB4urXrZ4o4sH";
const ROOM_ID = "!room";

function fromBase64Url(value) {
    return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
}

/** A CSPRNG stand-in that hands out the given seeds first, then fixed filler. */
function seededRandom(seeds) {
    const queue = seeds.map(fromBase64Url);
    let counter = 0x40;
    return bytes => {
        bytes.set(queue.shift() ?? new Uint8Array(bytes.length).fill(counter++));
        return bytes;
    };
}

/** Just enough of Hydrogen's storage for the `session` store. */
function memoryStorage() {
    const values = new Map();
    const txn = () => ({
        session: {
            get: async key => values.get(key),
            set: (key, value) => values.set(key, JSON.parse(JSON.stringify(value))),
            remove: key => values.delete(key),
        },
        complete: async () => {},
        abort: () => {},
    });
    return {values, storeNames: {session: "session"}, readTxn: async () => txn(), readWriteTxn: async () => txn()};
}

function request(result) {
    return {response: async () => {
        if (result instanceof Error) throw result;
        return result;
    }};
}

async function loadedCrypto(seeds = []) {
    const crypto = new CygnusCrypto(seededRandom(seeds));
    const {readFile} = await import("node:fs/promises");
    await crypto.load(await readFile(new URL("./wasm/cygnus_wasm_bg.wasm", import.meta.url)));
    return crypto;
}

/** A custodian that mints Alice's vector genesis link (it commits to USR_ROT_1). */
function custodianApi(crypto, overrides = {}) {
    const calls = {imports: []};
    const api = {
        cygnusCreatePrincipal: (masterKey, nextCommit) => {
            calls.created = {masterKey, nextCommit};
            return request({principal: USER_U, links: [U0]});
        },
        cygnusImportPrincipal: links => {
            calls.imports.push(links);
            return request({});
        },
        ...overrides,
    };
    return {api, calls};
}

async function aliceIdentity(extraSeeds = []) {
    const crypto = await loadedCrypto([USR_ROT_1, ...extraSeeds]);
    const storage = memoryStorage();
    const {api, calls} = custodianApi(crypto);
    const identity = await CygnusIdentity.create({
        storage, hsApi: api, crypto,
        masterSeed: USR_MSK,
        selfSigningSeed: SELF_SIGNING,
        deviceId: "HYDROGEN",
        displayUserId: "@alice:chat.example.org",
    });
    return {identity, crypto, storage, api, calls};
}

/** What a homeserver would propose for `request` in assisted mode. */
function draftFor(crypto, identity, req, {prevEvents = ["$prev"]} = {}) {
    const draft = {
        type: req.type,
        sender: identity.principal,
        content: req.content,
        origin_server_ts: 1792860000100,
        depth: 9,
        device_certificate: identity.deviceCertificate,
    };
    if (req.type !== "m.room.create") {
        draft.room_id = req.roomId;
        draft.prev_events = prevEvents;
        draft.auth_events = ["$auth"];
    }
    if (req.stateKey !== undefined) {
        draft.state_key = req.stateKey;
    }
    draft.hashes = {sha256: crypto.contentHash(draft).contentHash};
    return draft;
}

/**
 * A homeserver for assisted mode that checks the device signature on
 * `send_signed`. With `extendTip` it builds on the last event it accepted, as
 * a real one would; without it every draft cites a stale `$prev`.
 */
function assistedApi(crypto, identity, {draft, extendTip = true} = {}) {
    const sent = [];
    let tip;
    const api = {
        cygnusEventDraft: body => {
            const req = {roomId: body.room_id, type: body.type, stateKey: body.state_key, content: body.content};
            const prevEvents = extendTip && tip ? [tip] : ["$prev"];
            return request({event: draft ? draft(req, prevEvents) : draftFor(crypto, identity, req, {prevEvents})});
        },
        cygnusSendSigned: (txnId, event) => {
            const cert = event.device_certificate;
            const verified = crypto.verifyDeviceSignature(event, event.sender, cert.device_id, cert.device_key);
            if (!verified.ok) {
                return request(new Error(`bad device signature: ${verified.error}`));
            }
            sent.push(event);
            tip = crypto.eventId(event).eventId;
            return request({event_id: tip});
        },
    };
    return {api, sent};
}

export function tests() {
    return {
        "creates an identity from the custodian's genesis link": async assert => {
            const {identity, crypto, calls, storage} = await aliceIdentity();
            assert.equal(calls.created.masterKey, crypto.publicKey(USR_MSK));
            assert.equal(calls.created.nextCommit, crypto.rotationCommitment(USR_ROT_1));
            assert.equal(identity.principal, USER_U);
            assert.equal(identity.custodian, SERVER_A);
            assert.equal(identity.displayUserId, "@alice:chat.example.org");
            assert.equal(identity.height, 0);
            assert.equal(identity.deviceCertificate.device_id, "HYDROGEN");
            assert.equal(storage.values.get(IDENTITY_SESSION_KEY).rotationSeed, USR_ROT_1);
            const reloaded = await CygnusIdentity.load({storage, hsApi: {}, crypto});
            assert.equal(reloaded.principal, USER_U);
        },
        "refuses a genesis link for a different master key": async assert => {
            const crypto = await loadedCrypto([USR_ROT_1]);
            const {api} = custodianApi(crypto);
            await assert.rejects(CygnusIdentity.create({
                storage: memoryStorage(), hsApi: api, crypto,
                masterSeed: SELF_SIGNING, selfSigningSeed: USR_MSK,
                deviceId: "HYDROGEN", displayUserId: "@alice:chat.example.org",
            }));
        },
        "refuses a genesis link for another user ID": async assert => {
            const crypto = await loadedCrypto([USR_ROT_1]);
            const {api} = custodianApi(crypto);
            await assert.rejects(CygnusIdentity.create({
                storage: memoryStorage(), hsApi: api, crypto,
                masterSeed: USR_MSK, selfSigningSeed: SELF_SIGNING,
                deviceId: "HYDROGEN", displayUserId: "@mallory:chat.example.org",
            }));
        },
        "rotation extends the chain and commits to a fresh key": async assert => {
            const {identity, crypto, calls, storage} = await aliceIdentity([SELF_SIGNING, USR_ROT_2]);
            await identity.rotate();
            assert.equal(calls.imports.length, 1);
            assert.equal(identity.height, 1);
            assert.equal(identity.hasPendingRotation, false);
            assert.equal(crypto.verifyChain(identity.links).principal, USER_U);
            const tip = crypto.parseLink(identity.links[1]);
            assert.equal(tip.custodian, SERVER_A);
            assert.equal(tip.master_key, identity.masterKey);
            assert.equal(storage.values.get(IDENTITY_SESSION_KEY).rotationSeed, USR_ROT_2);
        },
        "a failed rotation keeps the signed link and resends it": async assert => {
            const {identity, storage} = await aliceIdentity([SELF_SIGNING, USR_ROT_2]);
            const sent = [];
            let fail = true;
            identity._hsApi = {cygnusImportPrincipal: links => {
                sent.push(links[0]);
                return request(fail ? new Error("offline") : {});
            }};
            await assert.rejects(identity.rotate());
            assert.equal(identity.hasPendingRotation, true);
            assert.equal(identity.height, 0);
            // the spent rotation key is still recorded, and the pending link persisted
            assert.equal(storage.values.get(IDENTITY_SESSION_KEY).pendingRotation.nextRotationSeed, USR_ROT_2);
            fail = false;
            await identity.rotate();
            assert.equal(sent.length, 2);
            assert.equal(sent[0], sent[1]);
            assert.equal(identity.height, 1);
            assert.equal(identity.hasPendingRotation, false);
        },
        "signs and submits an assisted-mode draft, then holds the device floor": async assert => {
            const {identity, crypto, storage} = await aliceIdentity();
            const {api, sent} = assistedApi(crypto, identity, {extendTip: false});
            const signer = new CygnusEventSigner({identity, crypto, hsApi: api, storage, createTxnId: () => "t1"});
            const content = {msgtype: "m.text", body: "hello"};
            const {eventId} = await signer.send({roomId: ROOM_ID, type: "m.room.message", content});
            assert.equal(sent.length, 1);
            assert.equal(eventId, crypto.eventId(sent[0]).eventId);
            assert.equal(storage.values.get(FLOORS_SESSION_KEY)[ROOM_ID], eventId);
            // the next draft omits the floor from prev_events, so it must be refused
            await assert.rejects(signer.send({roomId: ROOM_ID, type: "m.room.message", content}));
            assert.equal(sent.length, 1);
        },
        "a retry after a lost response resends the same signed event": async assert => {
            const {identity, crypto, storage} = await aliceIdentity();
            const {api, sent} = assistedApi(crypto, identity);
            let drafts = 0;
            const draft = api.cygnusEventDraft;
            api.cygnusEventDraft = body => { drafts += 1; return draft(body); };
            const sendSigned = api.cygnusSendSigned;
            const txnIds = [];
            let lose = true;
            api.cygnusSendSigned = (txnId, event) => {
                txnIds.push(txnId);
                const result = sendSigned(txnId, event);
                if (lose) {
                    lose = false;
                    // the homeserver accepted it, but the response never arrived
                    return request(new ConnectionError("lost"));
                }
                return result;
            };
            const signer = new CygnusEventSigner({identity, crypto, hsApi: api, storage, createTxnId: () => "unused"});
            const req = {roomId: ROOM_ID, type: "m.room.message", content: {msgtype: "m.text", body: "once"}};
            await assert.rejects(signer.send(req, {txnId: "pending-1"}));
            assert(storage.values.has(signedEventKey("pending-1")));
            const {eventId} = await signer.send(req, {txnId: "pending-1"});
            assert.equal(drafts, 1);
            assert.deepEqual(txnIds, ["pending-1", "pending-1"]);
            assert.equal(anotherJson(sent[0]), anotherJson(sent[1]));
            assert.equal(eventId, crypto.eventId(sent[0]).eventId);
            assert.equal(storage.values.has(signedEventKey("pending-1")), false);
        },
        "a definite rejection drops the signed event so the retry drafts afresh": async assert => {
            const {identity, crypto, storage} = await aliceIdentity();
            const {api} = assistedApi(crypto, identity);
            let drafts = 0;
            const draft = api.cygnusEventDraft;
            api.cygnusEventDraft = body => { drafts += 1; return draft(body); };
            const sendSigned = api.cygnusSendSigned;
            let reject = true;
            api.cygnusSendSigned = (txnId, event) => {
                if (reject) {
                    reject = false;
                    return request(new HomeServerError("PUT", "/send_signed", {errcode: "M_FORBIDDEN"}, 403));
                }
                return sendSigned(txnId, event);
            };
            const signer = new CygnusEventSigner({identity, crypto, hsApi: api, storage, createTxnId: () => "unused"});
            const req = {roomId: ROOM_ID, type: "m.room.message", content: {msgtype: "m.text", body: "again"}};
            await assert.rejects(signer.send(req, {txnId: "pending-2"}));
            assert.equal(storage.values.has(signedEventKey("pending-2")), false);
            await signer.send(req, {txnId: "pending-2"});
            assert.equal(drafts, 2);
        },
        "rejects drafts that differ from the request": async assert => {
            const {identity, crypto} = await aliceIdentity();
            const req = {roomId: ROOM_ID, type: "m.room.message", content: {msgtype: "m.text", body: "hi"}};
            const deps = {identity, crypto};
            assert.equal(checkDraft(draftFor(crypto, identity, req), req, deps), undefined);
            const swapped = draftFor(crypto, identity, {...req, content: {msgtype: "m.text", body: "bye"}});
            assert(checkDraft(swapped, req, deps).includes("content"));
            const badHash = {...draftFor(crypto, identity, req), hashes: {sha256: "AAAA"}};
            assert(checkDraft(badHash, req, deps).includes("hash"));
            const otherRoom = draftFor(crypto, identity, {...req, roomId: "!other"});
            assert(checkDraft(otherRoom, req, deps).includes("room"));
            const presigned = {...draftFor(crypto, identity, req), signatures: {}};
            assert(checkDraft(presigned, req, deps).includes("signatures"));
            assert(checkDraft(draftFor(crypto, identity, req), req, {...deps, floor: "$floor"}).includes("floor"));
        },
        "creates a room: create, join and join rule, with the custodian's chain checked": async assert => {
            const {identity, crypto, storage} = await aliceIdentity();
            const {api, sent} = assistedApi(crypto, identity, {draft: (req, prevEvents) => {
                const draft = draftFor(crypto, identity, req, {prevEvents});
                if (req.type === "m.room.create") {
                    draft.content = {...req.content, creator_links: {...req.content.creator_links, server: SERVER_A_LINKS}};
                    draft.hashes = {sha256: crypto.contentHash(draft).contentHash};
                }
                return draft;
            }});
            let txn = 0;
            const signer = new CygnusEventSigner({identity, crypto, hsApi: api, storage, createTxnId: () => `t${txn++}`});
            const roomId = await new CygnusRooms({identity, signer}).createRoom({name: "Lobby"});
            assert.deepEqual(sent.map(e => e.type), ["m.room.create", "m.room.member", "m.room.join_rules", "m.room.name"]);
            const create = sent[0];
            assert.equal(create.content.room_version, CYGNUS_ROOM_VERSION);
            assert.deepEqual(create.content.creator_links.user, identity.links);
            assert.equal(roomId, `!${crypto.eventId(create).eventId.slice(1)}`);
            assert.equal(sent[1].state_key, identity.principal);
            assert.deepEqual(sent[1].content, {membership: "join", custodian: SERVER_A});
            assert.equal(sent[1].room_id, roomId);
        },
        "refuses a create draft whose server chain is not the custodian's": async assert => {
            const {identity, crypto} = await aliceIdentity();
            const req = {type: "m.room.create", stateKey: "", content: {room_version: CYGNUS_ROOM_VERSION, creator_links: {user: identity.links}}};
            const withServer = server => {
                const draft = draftFor(crypto, identity, req);
                draft.content = {...req.content, creator_links: {...req.content.creator_links, server}};
                draft.hashes = {sha256: crypto.contentHash(draft).contentHash};
                return draft;
            };
            const deps = {identity, crypto};
            assert.equal(checkDraft(withServer(SERVER_A_LINKS), req, deps), undefined);
            assert(checkDraft(withServer([SERVER_B_GENESIS]), req, deps).includes("custodian"));
            assert(checkDraft(withServer([SERVER_A_LINKS[1]]), req, deps).includes("verify"));
        },
    };
}
