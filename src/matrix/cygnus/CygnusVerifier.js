/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import init, * as wasm from "./wasm/cygnus_wasm.js";

/**
 * Verify-only access to `cygnus-core` (MSC00FC) compiled to WebAssembly.
 *
 * Every method returns `{ok: true, ...}` or `{ok: false, error}` instead of
 * throwing, so a failed check can drive a trust indicator without try/catch at
 * each call site. Nothing here signs anything and no key material is held.
 *
 * The `.wasm` binary is built from `cygnus-core/cygnus-wasm`; see `wasm/README.md`.
 */
export class CygnusVerifier {
    constructor() {
        this._ready = undefined;
    }

    /**
     * Load the wasm module. Safe to call repeatedly.
     * @param {string|URL|BufferSource} [source] where to fetch the wasm from; defaults to the bundled asset
     */
    load(source) {
        if (!this._ready) {
            this._ready = init(source === undefined ? undefined : {module_or_path: source});
        }
        return this._ready;
    }

    /** Verify a link chain (base64url links, genesis first); returns the chain's principal. */
    verifyChain(links) {
        return this._run(() => ({principal: wasm.verifyChain(links)}));
    }

    /** Canonicalise a principal, rejecting padded or otherwise non-canonical forms. */
    parsePrincipal(id) {
        return this._run(() => ({principal: wasm.parsePrincipal(id)}));
    }

    /** Matrix event ID (`$` + reference hash) computed from the event's content. */
    eventId(event) {
        return this._run(() => ({eventId: wasm.eventId(JSON.stringify(event))}));
    }

    /** True when the PDU's own `event_id` (if present) matches its content. */
    verifyEventId(event, claimedId) {
        const computed = this.eventId(event);
        if (!computed.ok) {
            return computed;
        }
        return computed.eventId === claimedId
            ? {ok: true, eventId: computed.eventId}
            : {ok: false, error: `event ID mismatch: expected ${computed.eventId}`};
    }

    contentHash(event) {
        return this._run(() => ({contentHash: wasm.contentHash(JSON.stringify(event))}));
    }

    /** `publicKey` is the certified device key, unpadded base64url. */
    verifyDeviceSignature(event, sender, deviceId, publicKey) {
        return this._run(() => {
            wasm.verifyDeviceSignature(JSON.stringify(event), sender, deviceId, publicKey);
            return {};
        });
    }

    /** `publicKey` is the custodian server's key at `height`, unpadded base64url. */
    verifyCustodianSignature(event, custodian, height, publicKey) {
        return this._run(() => {
            wasm.verifyCustodianSignature(JSON.stringify(event), custodian, height, publicKey);
            return {};
        });
    }

    _run(fn) {
        if (!this._ready) {
            return {ok: false, error: "cygnus verifier not loaded"};
        }
        try {
            return {ok: true, ...fn()};
        } catch (err) {
            return {ok: false, error: err instanceof Error ? err.message : String(err)};
        }
    }
}
