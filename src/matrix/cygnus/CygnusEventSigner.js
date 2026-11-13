/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import anotherjson from "another-json";
import {HomeServerError} from "../error.js";

/** Session-store key for the per-room device floors (§9). */
export const FLOORS_SESSION_KEY = "cygnus.deviceFloors";

/** Session-store key for a signed event not yet confirmed by `send_signed`. */
export function signedEventKey(txnId) {
    return `cygnus.signed.${txnId}`;
}

function floorKey(identity, roomId) {
    return JSON.stringify([identity.principal, identity.deviceId, roomId]);
}

const SERVER_CHOSEN_FIELDS = ["origin_server_ts", "depth", "prev_events", "auth_events", "hashes"];
const FORBIDDEN_DRAFT_FIELDS = ["event_id", "signatures", "unsigned"];

function same(a, b) {
    return anotherjson.stringify(a) === anotherjson.stringify(b);
}

/**
 * Sends in progress, keyed by transaction ID and shared across instances, so
 * overlapping calls for the same transaction await one draft and one signed
 * event instead of signing two.
 * @type {Map<string, Promise<{eventId: string, event: object}>>}
 */
const inFlightSends = new Map();

/**
 * Check an assisted-mode draft (§9) against the request that produced it.
 * Returns an error message, or `undefined` when the draft may be signed.
 *
 * `request` is `{roomId?, type, stateKey?, content}`. For `m.room.create`, the
 * homeserver supplies `content.creator_links.server`; that chain must verify
 * and belong to the identity's custodian, and the rest of the content must be
 * exactly what was asked for.
 */
export function checkDraft(draft, request, {identity, crypto, floor}) {
    if (!draft || typeof draft !== "object") {
        return "draft is not an object";
    }
    for (const field of FORBIDDEN_DRAFT_FIELDS) {
        if (field in draft) {
            return `draft must not contain ${field}`;
        }
    }
    for (const field of SERVER_CHOSEN_FIELDS) {
        if (request.type === "m.room.create" && (field === "prev_events" || field === "auth_events")) {
            continue;
        }
        if (!(field in draft)) {
            return `draft is missing ${field}`;
        }
    }
    if (draft.sender !== identity.principal) {
        return `draft sender ${draft.sender} is not ${identity.principal}`;
    }
    if (draft.type !== request.type) {
        return `draft type ${draft.type} is not ${request.type}`;
    }
    if (draft.state_key !== request.stateKey) {
        return "draft state_key differs from the request";
    }
    if (request.type === "m.room.create") {
        for (const field of ["room_id", "prev_events", "auth_events"]) {
            if (field in draft) {
                return `a create draft must not contain ${field}`;
            }
        }
        const error = checkCreateContent(draft.content, request.content, {identity, crypto});
        if (error) {
            return error;
        }
    } else {
        if (draft.room_id !== request.roomId) {
            return `draft room ${draft.room_id} is not ${request.roomId}`;
        }
        if (!same(draft.content, request.content)) {
            return "draft content differs from the request";
        }
        if (floor && !(Array.isArray(draft.prev_events) && draft.prev_events.includes(floor))) {
            return `draft prev_events omit the device floor ${floor}`;
        }
    }
    if (!same(draft.device_certificate, identity.deviceCertificate)) {
        return "draft device_certificate differs from this device's";
    }
    const hash = crypto.contentHash(draft);
    if (!hash.ok) {
        return `cannot hash draft: ${hash.error}`;
    }
    if (draft.hashes?.sha256 !== hash.contentHash) {
        return "draft content hash does not match its content";
    }
    return undefined;
}

function checkCreateContent(content, requested, {identity, crypto}) {
    const server = content?.creator_links?.server;
    if (!Array.isArray(server) || server.length === 0) {
        return "create draft has no creator_links.server";
    }
    const verified = crypto.verifyChain(server);
    if (!verified.ok) {
        return `creator_links.server does not verify: ${verified.error}`;
    }
    if (verified.principal !== identity.custodian) {
        return `creator_links.server is ${verified.principal}, not this account's custodian ${identity.custodian}`;
    }
    const rest = {...content, creator_links: {...content.creator_links}};
    delete rest.creator_links.server;
    if (!same(rest, requested)) {
        return "create draft content differs from the request";
    }
    return undefined;
}

/**
 * Builds, signs and submits user-authored events through assisted mode
 * (§9). Hydrogen does not resolve room state, which §9 says requires assisted
 * mode: the homeserver proposes the envelope, and this class checks it, signs
 * it with the Cygnus device key and submits it through `send_signed`.
 *
 * It keeps the device floor per principal, device and room: the last event `send_signed` confirmed.
 * Every later draft for that room must list it in `prev_events`, and the floor
 * moves only after a confirmation.
 *
 * A signed event is stored under its transaction ID before it is submitted.
 * A retry with the same transaction ID resends that exact event, which §9
 * makes idempotent, so a lost response cannot produce a second, differently
 * signed event. Only a definite rejection from the homeserver drops it, and
 * the next attempt drafts afresh.
 */
export class CygnusEventSigner {
    constructor({identity, crypto, hsApi, storage, createTxnId}) {
        this._identity = identity;
        this._crypto = crypto;
        this._hsApi = hsApi;
        this._storage = storage;
        this._createTxnId = createTxnId;
    }

    /**
     * @param {{roomId?: string, type: string, stateKey?: string, content: object, via?: string[]}} request
     * @param {{txnId?: string, log?: object}} [options] pass the caller's transaction ID
     *     (e.g. a pending event's) so retries and remote echoes line up
     * @returns {Promise<{eventId: string, event: object}>} the submitted event and its ID
     */
    async send(request, {log, txnId = this._createTxnId()} = {}) {
        const ongoing = inFlightSends.get(txnId);
        if (ongoing) {
            return ongoing;
        }
        const run = this._send(request, {log, txnId}).finally(() => {
            if (inFlightSends.get(txnId) === run) {
                inFlightSends.delete(txnId);
            }
        });
        inFlightSends.set(txnId, run);
        return run;
    }

    /** Draft, sign and submit one request; `send` coalesces callers by transaction ID. */
    async _send(request, {log, txnId}) {
        let signed = await this._get(signedEventKey(txnId));
        if (!signed) {
            signed = await this._draftAndSign(request, txnId, log);
            await this._put(signedEventKey(txnId), signed);
        }
        const computed = this._crypto.eventId(signed);
        if (!computed.ok) {
            throw new Error(`cannot compute the event ID: ${computed.error}`);
        }
        let response;
        try {
            response = await this._hsApi.cygnusSendSigned(txnId, signed, {log}).response();
        } catch (err) {
            // keep the signed event for retryable failures (429, timeouts, 5xx) so a retry resends it
            const status = err.statusCode;
            if (err instanceof HomeServerError && status >= 400 && status < 500 && status !== 408 && status !== 429) {
                await this._put(signedEventKey(txnId), undefined);
            }
            throw err;
        }
        if (response.event_id !== computed.eventId) {
            throw new Error(`homeserver confirmed ${response.event_id}, but the signed event is ${computed.eventId}`);
        }
        // `m.room.create` has no room yet; its event ID determines the room ID (§5.6).
        const floorRoomId = request.roomId ?? `!${computed.eventId.slice(1)}`;
        await this._confirm(txnId, floorKey(this._identity, floorRoomId), computed.eventId);
        return {eventId: computed.eventId, event: signed};
    }

    async _draftAndSign(request, txnId, log) {
        const roomId = request.roomId;
        const key = roomId ? floorKey(this._identity, roomId) : undefined;
        const floors = key ? await this._get(FLOORS_SESSION_KEY) : undefined;
        // floors stored before they were keyed by principal and device used the room ID alone
        const floor = key ? (floors?.[key] ?? floors?.[roomId]) : undefined;
        const body = {
            type: request.type,
            content: request.content,
            transaction_id: txnId,
            device_certificate: this._identity.deviceCertificate,
        };
        if (roomId) {
            body.room_id = roomId;
        }
        if (request.stateKey !== undefined) {
            body.state_key = request.stateKey;
        }
        if (request.via?.length) {
            body.via = request.via;
        }
        const {event: draft} = await this._hsApi.cygnusEventDraft(body, {log}).response();
        const error = checkDraft(draft, request, {identity: this._identity, crypto: this._crypto, floor});
        if (error) {
            throw new Error(`refusing to sign the homeserver's draft: ${error}`);
        }
        const staleEpochError = await this._checkStaleEpoch(roomId, draft);
        if (staleEpochError) {
            throw new Error(`refusing to sign the homeserver's draft: ${staleEpochError}`);
        }
        return this._identity.signEvent(draft);
    }

    /**
     * The §9 stale-epoch heuristic: refuse a draft whose `auth_events` cite an
     * epoch event for this principal or its custodian that is older than the
     * newest one this client has observed in the room. A cited event the client
     * has not seen yet is accepted, since the homeserver is usually ahead of
     * `/sync`; that is why this is a heuristic, not a guarantee.
     */
    async _checkStaleEpoch(roomId, draft) {
        if (!roomId || !Array.isArray(draft.auth_events)) return undefined;
        const {roomState, timelineEvents} = this._storage.storeNames;
        const txn = await this._storage.readTxn([roomState, timelineEvents]);
        for (const [type, stateKey] of [["m.room.user_epoch", this._identity.principal], ["m.room.server_epoch", this._identity.custodian]]) {
            const observed = (await txn.roomState.get(roomId, type, stateKey))?.event;
            if (!observed?.event_id) continue;
            for (const eventId of draft.auth_events) {
                if (eventId === observed.event_id) continue;
                const cited = (await txn.timelineEvents.getByEventId(roomId, eventId))?.event;
                if (cited?.type === type && cited.state_key === stateKey &&
                    Number(cited.content?.height) < Number(observed.content?.height)) {
                    return `draft cites ${type} ${eventId} at height ${cited.content?.height}, older than the observed ${observed.event_id} at height ${observed.content?.height}`;
                }
            }
        }
        return undefined;
    }

    async _get(key) {
        const txn = await this._storage.readTxn([this._storage.storeNames.session]);
        return txn.session.get(key);
    }

    /** Store `value` under `key`, or remove the key when `value` is undefined. */
    async _put(key, value) {
        const txn = await this._storage.readWriteTxn([this._storage.storeNames.session]);
        try {
            if (value === undefined) {
                txn.session.remove(key);
            } else {
                txn.session.set(key, value);
            }
        } catch (err) {
            txn.abort();
            throw err;
        }
        await txn.complete();
    }

    /** Advance the room's floor and drop the stored signed event, in one transaction. */
    async _confirm(txnId, key, eventId) {
        const txn = await this._storage.readWriteTxn([this._storage.storeNames.session]);
        try {
            const floors = await txn.session.get(FLOORS_SESSION_KEY) ?? {};
            txn.session.set(FLOORS_SESSION_KEY, {...floors, [key]: eventId});
            txn.session.remove(signedEventKey(txnId));
        } catch (err) {
            txn.abort();
            throw err;
        }
        await txn.complete();
    }
}
