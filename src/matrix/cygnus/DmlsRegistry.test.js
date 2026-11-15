/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {
    buildRegistryJson, canonicalJson, DmlsRegistry, isB64u32, requestedBranchEventIds,
} from "./DmlsRegistry.js";

function b64u(bytes) {
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fill(byte) {
    return new Uint8Array(32).fill(byte);
}

function principal(byte) {
    return `@${b64u(fill(byte))}`;
}

const P1 = principal(0x11);
const P2 = principal(0x22);
const P3 = principal(0x33);
const MASTER1 = b64u(fill(0x41));
const MASTER2 = b64u(fill(0x42));
const SELF1 = b64u(fill(0x51));
const SELF2 = b64u(fill(0x52));
const DEVICE1 = b64u(fill(0x61));
const DEVICE2 = b64u(fill(0x62));

function certificate(deviceId, deviceKey, selfSigningKey) {
    return {
        version: 1,
        device_id: deviceId,
        device_key: deviceKey,
        self_signing_key: selfSigningKey,
        self_signing_signature: b64u(new Uint8Array(64).fill(0x71)),
        device_key_signature: b64u(new Uint8Array(64).fill(0x72)),
    };
}

function epoch(principalKey, masterKey, height, eventId, authEvents = []) {
    return {
        event_id: eventId, type: "m.room.user_epoch", state_key: principalKey,
        sender: principalKey, auth_events: authEvents,
        content: {status: "active", height, master_key: masterKey},
    };
}

function root(principalKey, selfSigningKey, height, generation, previousRoot, eventId, authEvents) {
    return {
        event_id: eventId, type: "m.room.device_root", state_key: principalKey,
        sender: principalKey, auth_events: authEvents,
        content: {self_signing_key: selfSigningKey, user_epoch_height: height,
            generation, previous_root: previousRoot, master_signature: "sig"},
    };
}

function member(principalKey, eventId, deviceCertificate, authEvents) {
    return {
        event_id: eventId, type: "m.room.member", state_key: principalKey,
        sender: principalKey, auth_events: authEvents,
        content: {membership: "join"}, device_certificate: deviceCertificate,
    };
}

/** Alice and Bob each have a height-7 genesis root, one device, and a branch tip. */
function household({ extra = [] } = {}) {
    const e1 = epoch(P1, MASTER1, 7, "$epoch1");
    const e2 = epoch(P2, MASTER2, 7, "$epoch2");
    const r1 = root(P1, SELF1, 7, 1, null, "$root1", ["$epoch1"]);
    const r2 = root(P2, SELF2, 7, 1, null, "$root2", ["$epoch2"]);
    const m1 = member(P1, "$member1", certificate("D1", DEVICE1, SELF1), ["$epoch1", "$root1"]);
    const m2 = member(P2, "$member2", certificate("D2", DEVICE2, SELF2), ["$epoch2", "$root2"]);
    const b1 = {
        event_id: "$branch1", type: "m.dmls.commit", sender: P1,
        auth_events: ["$epoch1", "$root1", "$member1"], content: {},
    };
    const b2 = {
        event_id: "$branch2", type: "m.dmls.commit", sender: P2,
        auth_events: ["$epoch2", "$root2", "$member2"], content: {},
    };
    return {
        events: [e1, e2, r1, r2, m1, m2, b1, b2, ...extra],
        requested: ["$branch1", "$branch2"],
        revoked: [],
    };
}

function reasonsHarness() {
    return (mutate) => {
        const input = household();
        mutate(input);
        return buildRegistryJson(input);
    };
}

export function tests() {
    const mutateAndBuild = reasonsHarness();

    return {
        "defers when revocation completeness is not supplied": assert => {
            const incomplete = household();
            delete incomplete.revoked;
            assert.deepEqual(buildRegistryJson(incomplete), {reason: "bad_revocations"});
        },

        "builds canonical principal-major registryJson": assert => {
            const {registryJson} = buildRegistryJson(household());
            assert.equal(typeof registryJson, "string");
            assert.equal(registryJson.includes(" "), false);
            assert(registryJson.startsWith('{"certificates":['));
            const parsed = JSON.parse(registryJson);
            assert.deepEqual(parsed.masterKeys.map(entry => entry.principal), [P1, P2]);
            assert.deepEqual(parsed.roots.map(entry => entry.userEpochHeight), [7, 7]);
            assert.deepEqual(parsed.roots.map(entry => entry.generation), [1, 1]);
            assert.deepEqual(parsed.certificates.map(entry => entry.certificate.device_id), ["D1", "D2"]);
            assert.deepEqual(parsed.revoked, []);
            assert.equal(registryJson, canonicalJson(parsed));
        },

        "scopes entries to the requested branches' auth ancestry": assert => {
            const e3 = epoch(P3, b64u(fill(0x43)), 7, "$epoch3");
            const r3 = root(P3, b64u(fill(0x53)), 7, 1, null, "$root3", ["$epoch3"]);
            const m3 = member(P3, "$member3", certificate("D3", b64u(fill(0x63)), b64u(fill(0x53))), ["$epoch3", "$root3"]);
            const {registryJson} = buildRegistryJson(household({extra: [e3, r3, m3]}));
            const parsed = JSON.parse(registryJson);
            assert.equal(parsed.masterKeys.some(entry => entry.principal === P3), false);
            assert.equal(parsed.roots.some(entry => entry.principal === P3), false);
            assert.equal(parsed.certificates.some(entry => entry.principal === P3), false);
            assert.equal(parsed.certificates.every(entry => isB64u32(entry.certificate.device_key)), true);
        },

        "defers when a requested branch is not in the bundle": assert => {
            const result = mutateAndBuild(input => { input.requested.push("$missing"); });
            assert.deepEqual(result, {reason: "missing_branch"});
        },

        "defers when a branch cites an auth event the bundle lacks": assert => {
            const result = mutateAndBuild(input => {
                input.events.find(event => event.event_id === "$branch1").auth_events.push("$extra");
            });
            assert.deepEqual(result, {reason: "missing_auth_event"});
        },

        "defers when a genesis device root starts after generation one": assert => {
            const result = mutateAndBuild(input => {
                input.events.find(event => event.event_id === "$root1").content.generation = 2;
            });
            assert.deepEqual(result, {reason: "root_gap"});
        },

        "defers when a genesis device root names a previous root": assert => {
            const result = mutateAndBuild(input => {
                input.events.find(event => event.event_id === "$root1").content.previous_root = "$nope";
            });
            assert.deepEqual(result, {reason: "root_previous"});
        },

        "defers on a same-height root generation gap": assert => {
            const input = household();
            input.events.push(root(P1, SELF1, 7, 3, "$root1", "$root1c", ["$epoch1", "$root1"]));
            input.events.find(event => event.event_id === "$branch1").auth_events.push("$root1c");
            assert.deepEqual(buildRegistryJson(input), {reason: "root_gap"});
        },

        "defers on a same-height previous-root mismatch": assert => {
            const input = household();
            input.events.push(root(P1, SELF1, 7, 2, "$wrong", "$root1b", ["$epoch1", "$root1"]));
            input.events.find(event => event.event_id === "$branch1").auth_events.push("$root1b");
            assert.deepEqual(buildRegistryJson(input), {reason: "root_previous"});
        },

        "defers when a root has no certified device in its ancestry": assert => {
            const result = mutateAndBuild(input => {
                input.events = input.events.filter(event => event.event_id !== "$member2");
                input.events.find(event => event.event_id === "$branch2").auth_events =
                    ["$epoch2", "$root2"];
            });
            assert.deepEqual(result, {reason: "root_without_certificate"});
        },

        "defers when a principal has no master key": assert => {
            const result = mutateAndBuild(input => {
                input.events = input.events.filter(event => event.event_id !== "$epoch2");
                input.events.find(event => event.event_id === "$root2").auth_events = [];
                input.events.find(event => event.event_id === "$member2").auth_events = ["$root2"];
                input.events.find(event => event.event_id === "$branch2").auth_events =
                    ["$root2", "$member2"];
            });
            assert.deepEqual(result, {reason: "missing_master_key"});
        },

        "accepts generation restart at a higher user epoch height": assert => {
            const input = household();
            input.events.push(root(P1, SELF1, 8, 1, "$root1", "$root1b", ["$epoch1", "$root1"]));
            input.events.find(event => event.event_id === "$branch1").auth_events.push("$root1b");
            const result = buildRegistryJson(input);
            assert.equal(typeof result.registryJson, "string");
            const roots = JSON.parse(result.registryJson).roots.filter(root => root.principal === P1);
            assert.deepEqual(roots.map(({userEpochHeight, generation}) => [userEpochHeight, generation]), [[7, 1], [8, 1]]);
        },

        "accepts a null previous_root when a higher epoch re-anchors": assert => {
            const input = household();
            input.events.push(root(P1, SELF1, 8, 1, null, "$root1c", ["$epoch1", "$root1"]));
            input.events.find(event => event.event_id === "$branch1").auth_events.push("$root1c");
            const result = buildRegistryJson(input);
            assert.equal(typeof result.registryJson, "string");
            const roots = JSON.parse(result.registryJson).roots.filter(root => root.principal === P1);
            assert.deepEqual(roots.map(({userEpochHeight, generation}) => [userEpochHeight, generation]), [[7, 1], [8, 1]]);
        },

        "rejects duplicate device keys certified for different devices": assert => {
            const result = mutateAndBuild(input => {
                input.events.find(event => event.event_id === "$member2").device_certificate =
                    certificate("D9", DEVICE1, SELF2);
            });
            // A member event's certificate must still chain to its own root; the
            // builder only checks key/device conflicts, which this exercises.
            assert.deepEqual(result, {reason: "certificate_conflict"});
        },

        "rejects conflicting duplicate certificates for the same device": assert => {
            const input = household();
            input.events.find(event => event.event_id === "$member2").device_certificate =
                certificate("D1", DEVICE1, SELF2);
            input.events.find(event => event.event_id === "$branch2").auth_events.push("$member1");
            input.events.find(event => event.event_id === "$member1").auth_events.push("$member2");
            assert.deepEqual(buildRegistryJson(input), {reason: "certificate_conflict"});
        },

        "requires an explicit revocation list": assert => {
            const {revoked, ...input} = household();
            assert.deepEqual(revoked, []);
            assert.deepEqual(buildRegistryJson(input), {reason: "bad_revocations"});
        },

        "validates revocations and deduplicates them": assert => {
            const key = b64u(fill(0x81));
            const input = {...household(), revoked: [key, key]};
            const parsed = JSON.parse(buildRegistryJson(input).registryJson);
            assert.deepEqual(parsed.revoked, [key]);
            assert.deepEqual(buildRegistryJson({...input, revoked: ["not-a-key"]}),
                {reason: "bad_revocation"});
        },

        "reads the resolved branch event ids, skipping the genesis reference": assert => {
            assert.deepEqual(requestedBranchEventIds({resolves: [
                {mls_epoch: 2, commit_id: "abc", event_id: "$a"},
                {mls_epoch: 1, commit_id: "def"},
                {mls_epoch: 2, commit_id: "abc", event_id: "$a"},
            ]}), ["$a"]);
            assert.deepEqual(requestedBranchEventIds({}), []);
        },

        "fetches a fresh tip bundle per merge and defers without events": async assert => {
            const {events} = household();
            let calls = 0;
            const hsApi = {
                cygnusTipBundle: () => {
                    calls++;
                    return {response: async () => ({events})};
                },
            };
            const getRevokedDeviceKeys = async () => [];
            const registry = new DmlsRegistry({hsApi, getRevokedDeviceKeys});
            const merge = {type: "m.dmls.merge", content: {resolves: [
                {event_id: "$branch1"}, {event_id: "$branch2"},
            ]}};
            const first = await registry.getRegistryJson("!room", merge);
            const second = await registry.getRegistryJson("!room", merge);
            assert.equal(typeof first, "string");
            assert.equal(first, second);
            assert.equal(calls, 2);

            const empty = new DmlsRegistry({hsApi: {
                cygnusTipBundle: () => ({response: async () => ({events: []})}),
            }, getRevokedDeviceKeys});
            assert.deepEqual(await empty.getRegistryJson("!room", merge), {deferred: "missing_branch"});
            const offline = new DmlsRegistry({hsApi: {
                cygnusTipBundle: () => ({response: async () => { throw new Error("offline"); }}),
            }, getRevokedDeviceKeys});
            assert.deepEqual(await offline.getRegistryJson("!room", merge), {deferred: "tip_bundle_unavailable"});
            // A commit never needs a registry.
            assert.equal(await registry.getRegistryJson("!room", {type: "m.dmls.commit"}), undefined);
        },

        "defers rather than assert revocations without a real source": async assert => {
            const {events} = household();
            const hsApi = {cygnusTipBundle: () => ({response: async () => ({events})})};
            const merge = {type: "m.dmls.merge", content: {resolves: [
                {event_id: "$branch1"}, {event_id: "$branch2"},
            ]}};

            // A missing provider must not become `revoked: []`.
            const missing = new DmlsRegistry({hsApi});
            assert.deepEqual(await missing.getRegistryJson("!room", merge), {deferred: "revocations_unavailable"});

            const failing = new DmlsRegistry({hsApi, getRevokedDeviceKeys: async () => {
                throw new Error("no store");
            }});
            assert.deepEqual(await failing.getRegistryJson("!room", merge), {deferred: "revocations_unavailable"});

            const malformed = new DmlsRegistry({hsApi, getRevokedDeviceKeys: async () => "none"});
            assert.deepEqual(await malformed.getRegistryJson("!room", merge), {deferred: "revocations_unavailable"});

            // The provider sees the requested branch scope and can complete it.
            let scope = null;
            const present = new DmlsRegistry({hsApi, getRevokedDeviceKeys: async (_roomId, requested) => {
                scope = requested;
                return [];
            }});
            const result = await present.getRegistryJson("!room", merge);
            assert.deepEqual(scope, ["$branch1", "$branch2"]);
            assert.deepEqual(JSON.parse(result).revoked, []);
        },
    };
}
