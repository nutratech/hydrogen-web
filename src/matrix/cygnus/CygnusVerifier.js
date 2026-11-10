/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import init, * as wasm from "./wasm/cygnus_wasm.js";
import anotherjson from "another-json";

const wasmUrl = new URL("./wasm/cygnus_wasm_bg.wasm", import.meta.url);
const loadTimeoutMs = 30000;
let initializedSource;
let initializing;
let wasmInitialized = false;

function canonicalJson(value) {
    return anotherjson.stringify(value);
}

function sameSource(a, b) {
    if (a === b) return true;
    if ((typeof a === "string" || a instanceof URL) && (typeof b === "string" || b instanceof URL)) {
        return String(a) === String(b);
    }
    const bytes = value => {
        if (value instanceof ArrayBuffer) return new Uint8Array(value);
        if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        return undefined;
    };
    const left = bytes(a);
    const right = bytes(b);
    return !!left && !!right && left.length === right.length && left.every((value, index) => value === right[index]);
}

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
        this._loaded = false;
    }

    /**
     * Load the wasm module. Safe to call repeatedly.
     * @param {string|URL|BufferSource} [source] where to fetch the wasm from; defaults to the bundled asset
     */
    load(source) {
        const requestedSource = source === undefined ? wasmUrl : source;
        if (this._loaded || (wasmInitialized && sameSource(initializedSource, requestedSource))) {
            this._loaded = true;
            return Promise.resolve();
        }
        if (this._ready) return this._ready;
        if (initializing && !sameSource(initializedSource, requestedSource)) {
            return Promise.reject(new Error("cygnus wasm is already initializing from a different source"));
        }
        if (initializedSource !== undefined && !sameSource(initializedSource, requestedSource)) {
            return Promise.reject(new Error("cygnus wasm is already initialized from a different source"));
        }
        initializedSource = requestedSource;
        initializing = true;
        let timeout;
        const controller = typeof AbortController === "function" ? new AbortController() : undefined;
        const initSource = controller && (typeof requestedSource === "string" || requestedSource instanceof URL)
            ? new Request(requestedSource, {signal: controller.signal})
            : requestedSource;
        const attempt = Promise.race([
            init({module_or_path: initSource}),
            new Promise((_, reject) => {
                timeout = setTimeout(() => {
                    controller?.abort();
                    reject(new Error("cygnus wasm initialization timed out"));
                }, loadTimeoutMs);
            }),
        ]).then(() => {
            wasmInitialized = true;
            this._loaded = true;
        }).catch(err => {
            if (initializedSource === requestedSource) initializedSource = undefined;
            throw err;
        }).finally(() => {
            clearTimeout(timeout);
            initializing = false;
            if (this._ready === attempt) this._ready = undefined;
        });
        this._ready = attempt;
        return attempt;
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
        return this._run(() => ({eventId: wasm.eventId(canonicalJson(event))}));
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
        return this._run(() => ({contentHash: wasm.contentHash(canonicalJson(event))}));
    }

    /** `publicKey` is the certified device key, unpadded base64url. */
    verifyDeviceSignature(event, sender, deviceId, publicKey) {
        return this._run(() => {
            wasm.verifyDeviceSignature(canonicalJson(event), sender, deviceId, publicKey);
            return {};
        });
    }

    /** `publicKey` is the custodian server's key at `height`, unpadded base64url. */
    verifyCustodianSignature(event, custodian, height, publicKey) {
        return this._run(() => {
            wasm.verifyCustodianSignature(canonicalJson(event), custodian, height, publicKey);
            return {};
        });
    }

    _run(fn) {
        if (!this._loaded) {
            return {ok: false, error: "cygnus verifier not loaded"};
        }
        try {
            return {ok: true, ...fn()};
        } catch (err) {
            return {ok: false, error: err instanceof Error ? err.message : String(err)};
        }
    }
}
