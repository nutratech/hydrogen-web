/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {isPrincipal} from "./constants.js";

/** 00FC per-principal device-root state event. */
export const DEVICE_ROOT_TYPE = "m.room.device_root";
/** 00FC user epoch, which commits the master key. */
export const USER_EPOCH_TYPE = "m.room.user_epoch";
/** The only event whose apply path needs the registry. */
export const MERGE_EVENT_TYPE = "m.dmls.merge";

const B64U_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Decode unpadded base64url, returning undefined for anything malformed.
 * @param {unknown} value
 * @returns {Uint8Array|undefined}
 */
export function decodeB64u(value) {
    if (typeof value !== "string" || !B64U_RE.test(value)) {
        return undefined;
    }
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") +
        "=".repeat((4 - (value.length % 4)) % 4);
    try {
        const binary = atob(padded);
        const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
        const canonical = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        return canonical === value ? bytes : undefined;
    } catch (_) {
        return undefined;
    }
}

/** True for a canonical 32-byte unpadded base64url value. */
export function isB64u32(value) {
    return decodeB64u(value)?.length === 32;
}

/**
 * Canonical JSON: compact, object keys sorted at every depth. `registryJson` is
 * parsed strictly by `cygnus_dmls::registry_json`, which rejects any input that
 * does not round-trip through the same canonical writer.
 */
export function canonicalJson(value) {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
    }
    if (value && typeof value === "object") {
        const keys = Object.keys(value).sort();
        return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
    }
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
        throw new Error("registryJson numbers must be safe integers");
    }
    return JSON.stringify(value);
}

function defer(reason) {
    return {reason};
}

function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function isUint(value) {
    return Number.isSafeInteger(value) && value >= 0;
}

/**
 * The event ids a merge's registry must be scoped to: the branches it resolves.
 * Each reference is `{mls_epoch, commit_id, event_id}`; the genesis reference
 * has no room event.
 * @param {object} content
 * @returns {string[]}
 */
export function requestedBranchEventIds(content) {
    const resolves = content?.resolves;
    if (!Array.isArray(resolves)) {
        return [];
    }
    const ids = [];
    for (const ref of resolves) {
        if (typeof ref?.event_id === "string" && !ids.includes(ref.event_id)) {
            ids.push(ref.event_id);
        }
    }
    return ids;
}

/**
 * Derive the canonical `registryJson` for one merge from a bundle of events the
 * caller has already verified.
 *
 * The registry is a trust boundary: the bundle must contain the requested
 * branch events and, transitively, every event their `auth_events` cite. The
 * builder never falls back to current room state, never guesses at a missing
 * root or certificate, and never mutates the bundle. Any gap returns
 * `{reason}`, which keeps `dmlsMerge` deferred and changes nothing.
 *
 * @param {object} input
 * @param {object[]} input.events full, already-verified events
 * @param {string[]} input.requested event ids of the branches being merged
 * @param {string[]} input.revoked 32-byte unpadded base64url device keys the
 *     caller's source confirms are revoked; `[]` means it confirms none is.
 *     This is required so silence can never be read as "nothing revoked".
 * @returns {{registryJson: string}|{reason: string}}
 */
export function buildRegistryJson({events, requested, revoked}) {
    if (!Array.isArray(events)) {
        return defer("bundle_events");
    }
    if (!Array.isArray(requested) || requested.length === 0) {
        return defer("missing_requested");
    }
    if (!Array.isArray(revoked)) {
        return defer("bad_revocations");
    }

    const byId = new Map();
    for (const event of events) {
        if (!isObject(event) || typeof event.event_id !== "string") {
            return defer("bundle_event");
        }
        if (byId.has(event.event_id)) {
            return defer("bundle_duplicate_event");
        }
        byId.set(event.event_id, event);
    }

    // Walk `auth_events` from every requested branch. Identity entries come from
    // the auth ancestry, not from the branch events themselves.
    const ancestry = new Map();
    const queue = [];
    for (const id of requested) {
        const branch = byId.get(id);
        if (!branch) {
            return defer("missing_branch");
        }
        queue.push(branch);
    }
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const event = queue[cursor];
        if (ancestry.has(event.event_id)) {
            continue;
        }
        ancestry.set(event.event_id, event);
        const authEvents = event.auth_events ?? [];
        if (!Array.isArray(authEvents)) {
            return defer("bad_auth_events");
        }
        for (const authId of authEvents) {
            const authEvent = byId.get(authId);
            if (!authEvent) {
                return defer("missing_auth_event");
            }
            queue.push(authEvent);
        }
    }
    const inAuthAncestry = [...ancestry.values()].filter(event => !requested.includes(event.event_id));

    // `m.room.user_epoch`: one master key per principal, at the highest height.
    const masterByPrincipal = new Map();
    for (const event of inAuthAncestry) {
        if (event.type !== USER_EPOCH_TYPE) {
            continue;
        }
        if (!isPrincipal(event.state_key) || event.sender !== event.state_key) {
            return defer("bad_user_epoch");
        }
        const masterKey = event.content?.master_key;
        const height = event.content?.height;
        if (!isB64u32(masterKey) || !isUint(height)) {
            return defer("bad_master_key");
        }
        const previous = masterByPrincipal.get(event.state_key);
        if (previous && previous.height === height && previous.key !== masterKey) {
            return defer("master_conflict");
        }
        if (!previous || height > previous.height) {
            masterByPrincipal.set(event.state_key, {height, key: masterKey});
        }
    }

    // `m.room.device_root`: the complete chain per principal, ascending by
    // (userEpochHeight, generation). The native parser requires exactly that
    // principal-major order, so sort it here.
    const rootsByPrincipal = new Map();
    for (const event of inAuthAncestry) {
        if (event.type !== DEVICE_ROOT_TYPE) {
            continue;
        }
        if (!isPrincipal(event.state_key) || event.sender !== event.state_key) {
            return defer("bad_device_root");
        }
        const content = event.content ?? {};
        const height = content.user_epoch_height;
        const generation = content.generation;
        const previousRoot = content.previous_root ?? null;
        if (!isB64u32(content.self_signing_key) || !isUint(height) || !isUint(generation) ||
            generation < 1 || (previousRoot !== null && typeof previousRoot !== "string")) {
            return defer("bad_device_root");
        }
        const roots = rootsByPrincipal.get(event.state_key) ?? [];
        roots.push({height, generation, eventId: event.event_id, key: content.self_signing_key, previousRoot});
        rootsByPrincipal.set(event.state_key, roots);
    }

    const roots = [];
    for (const [principal, chain] of [...rootsByPrincipal.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
        if (!masterByPrincipal.has(principal)) {
            return defer("missing_master_key");
        }
        chain.sort((a, b) => a.height === b.height ? a.generation - b.generation : a.height - b.height);
        // Generation increments within an epoch height and restarts at 1
        // when a higher user epoch re-anchors the root chain.
        let previous = null;
        for (const root of chain) {
            if (!previous) {
                if (root.generation !== 1) {
                    return defer("root_gap");
                }
                if (root.previousRoot !== null) {
                    return defer("root_previous");
                }
            } else if (root.height === previous.height) {
                if (root.generation !== previous.generation + 1) {
                    return defer("root_gap");
                }
                if (root.previousRoot !== previous.eventId) {
                    return defer("root_previous");
                }
            } else {
                // A higher user epoch re-anchors at generation 1, naming either
                // the last root at a lower height or null.
                if (root.generation !== 1) {
                    return defer("root_gap");
                }
                if (root.previousRoot !== null && root.previousRoot !== previous.eventId) {
                    return defer("root_previous");
                }
            }
            if (root.previousRoot !== null && !ancestry.has(root.previousRoot)) {
                return defer("root_previous");
            }
            roots.push({
                principal,
                userEpochHeight: root.height,
                generation: root.generation,
                selfSigningKey: root.key,
            });
            previous = root;
        }
    }

    // Device certificates, including stale ones: merge planning needs them to
    // recognise and remove a device that rotated.
    const certificateByDeviceKey = new Map();
    const certificates = [];
    for (const event of inAuthAncestry) {
        const certificate = event.device_certificate;
        if (certificate === undefined) {
            continue;
        }
        if (!isPrincipal(event.sender) || !isObject(certificate)) {
            return defer("bad_certificate");
        }
        const {version, device_id: deviceId, device_key: deviceKey,
            self_signing_key: selfSigningKey, self_signing_signature: selfSigningSignature,
            device_key_signature: deviceKeySignature} = certificate;
        if (version !== 1 || typeof deviceId !== "string" || deviceId.length === 0 ||
            !isB64u32(deviceKey) || !isB64u32(selfSigningKey) ||
            typeof selfSigningSignature !== "string" || !B64U_RE.test(selfSigningSignature) ||
            typeof deviceKeySignature !== "string" || !B64U_RE.test(deviceKeySignature)) {
            return defer("bad_certificate");
        }
        const existing = certificateByDeviceKey.get(deviceKey);
        if (existing) {
            if (existing.principal !== event.sender || existing.deviceId !== deviceId ||
                existing.canonical !== canonicalJson(certificate)) {
                return defer("certificate_conflict");
            }
            continue;
        }
        certificateByDeviceKey.set(deviceKey, {principal: event.sender, deviceId, canonical: canonicalJson(certificate)});
        certificates.push({principal: event.sender, certificate: {
            version, device_id: deviceId, device_key: deviceKey,
            self_signing_key: selfSigningKey,
            self_signing_signature: selfSigningSignature,
            device_key_signature: deviceKeySignature,
        }});
    }
    certificates.sort((a, b) => {
        const left = `${a.principal}\u0000${a.certificate.device_id}\u0000${a.certificate.device_key}`;
        const right = `${b.principal}\u0000${b.certificate.device_id}\u0000${b.certificate.device_key}`;
        return left < right ? -1 : left > right ? 1 : 0;
    });

    // A root with no certified device in ancestry cannot be resolved by wasm.
    for (const [principal] of rootsByPrincipal) {
        if (!certificates.some(entry => entry.principal === principal)) {
            return defer("root_without_certificate");
        }
    }

    const revokedKeys = [];
    for (const key of revoked) {
        if (!isB64u32(key)) {
            return defer("bad_revocation");
        }
        if (!revokedKeys.includes(key)) {
            revokedKeys.push(key);
        }
    }
    revokedKeys.sort();

    const masterKeys = [...masterByPrincipal.entries()]
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([principal, master]) => ({principal, key: master.key}));

    if (masterKeys.length === 0) {
        return defer("missing_master_key");
    }

    try {
        return {registryJson: canonicalJson({masterKeys, roots, certificates, revoked: revokedKeys})};
    } catch (_) {
        return defer("bad_registry");
    }
}

/**
 * Fetch the tip bundle for a merge and derive its registry.
 *
 * Returns the registry JSON string on success, or `{deferred: reason}` when the
 * bundle is unavailable, incomplete, or fails a rule. `DmlsService` turns the
 * latter into `deferred` / `registry_unavailable` with the reason attached.
 *
 * The registry is per call and never cached: revocation and rotation are
 * exactly what it must reflect.
 *
 * A merge registry always states whether any device is revoked, and wasm
 * trusts that statement. So `revoked: []` is only meaningful when a real
 * source confirms nothing is revoked for the requested branches. Without
 * such a source there is no defensible registry: the client defers with
 * `revocations_unavailable` rather than let the default empty list stand in
 * for "nobody is revoked".
 */
export class DmlsRegistry {
    /**
     * @param {object} options
     * @param {object} [options.hsApi] HomeServerApi with `cygnusTipBundle`
     * @param {(roomId: string, requested: string[]) => Promise<string[]>} [options.getRevokedDeviceKeys]
     *     Returns every revoked device key relevant to the requested branch
     *     events. Returning `[]` asserts that none is revoked; the source must
     *     cover every principal in scope, not just the local user's devices.
     */
    constructor({hsApi, getRevokedDeviceKeys} = {}) {
        this._hsApi = hsApi;
        this._getRevokedDeviceKeys = getRevokedDeviceKeys;
    }

    /**
     * @param {string} roomId
     * @param {object} event the received `m.dmls.merge`
     * @returns {Promise<string|{deferred: string}|undefined>}
     */
    async getRegistryJson(roomId, event) {
        if (event?.type !== MERGE_EVENT_TYPE) {
            return undefined;
        }
        const requested = requestedBranchEventIds(event.content);
        if (requested.length === 0) {
            return {deferred: "missing_requested"};
        }
        // Fail closed before any work: a registry must never claim that
        // nothing is revoked on behalf of a source that does not exist.
        if (!this._getRevokedDeviceKeys) {
            return {deferred: "revocations_unavailable"};
        }
        if (!this._hsApi?.cygnusTipBundle) {
            return {deferred: "tip_bundle_unavailable"};
        }
        let bundle;
        try {
            bundle = await this._hsApi.cygnusTipBundle(roomId).response();
        } catch (_) {
            return {deferred: "tip_bundle_unavailable"};
        }
        const events = Array.isArray(bundle) ? bundle : bundle?.events;
        if (!Array.isArray(events)) {
            return {deferred: "tip_bundle_shape"};
        }
        let revoked;
        try {
            revoked = await this._getRevokedDeviceKeys(roomId, requested);
        } catch (_) {
            return {deferred: "revocations_unavailable"};
        }
        if (!Array.isArray(revoked)) {
            return {deferred: "revocations_unavailable"};
        }
        const result = buildRegistryJson({events, requested, revoked});
        return result.registryJson ?? {deferred: result.reason};
    }
}
