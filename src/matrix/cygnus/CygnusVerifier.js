/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import init, * as wasm from "./wasm/cygnus_wasm.js";
import anotherjson from "another-json";

const wasmUrl = new URL("./wasm/cygnus_wasm_bg.wasm", import.meta.url);
const loadTimeoutMs = 30000;
// The source the module was (or is being) initialized from. It stays set
// until the underlying init() settles, even after a load() timed out, because
// that init cannot be cancelled and a second source must not race it.
let initializedSource;
// The in-flight underlying init(), shared by every verifier instance.
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
 * Start the underlying init() for `source`. Throws synchronously (leaving no
 * state behind) when `source` cannot be turned into a request.
 */
function startInit(source) {
    const controller = typeof AbortController === "function" ? new AbortController() : undefined;
    const initSource = controller && (typeof source === "string" || source instanceof URL)
        ? new Request(source, {signal: controller.signal})
        : source;
    initializedSource = source;
    const promise = init({module_or_path: initSource}).then(() => {
        wasmInitialized = true;
    }, err => {
        initializedSource = undefined;
        throw err;
    }).finally(() => {
        initializing = undefined;
    });
    // Callers race this against their own timeout; keep the settled rejection handled.
    promise.catch(() => {});
    return {promise, abort: () => controller?.abort()};
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
        if (initializedSource !== undefined && !sameSource(initializedSource, requestedSource)) {
            return Promise.reject(new Error(wasmInitialized
                ? "cygnus wasm is already initialized from a different source"
                : "cygnus wasm is already initializing from a different source"));
        }
        if (wasmInitialized) {
            this._loaded = true;
            return Promise.resolve();
        }
        if (this._ready) return this._ready;
        if (!initializing) {
            try {
                initializing = startInit(requestedSource);
            } catch (err) {
                return Promise.reject(err);
            }
        }
        const {promise, abort} = initializing;
        let timeout;
        const attempt = Promise.race([
            promise,
            new Promise((_, reject) => {
                timeout = setTimeout(() => {
                    abort();
                    reject(new Error("cygnus wasm initialization timed out"));
                }, loadTimeoutMs);
            }),
        ]).then(() => {
            this._loaded = true;
        }).finally(() => {
            clearTimeout(timeout);
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

    /**
     * `height` is the custodian's signing height; `publicKey` is its key at
     * that height, unpadded base64url. The wasm API takes the height as a
     * decimal string because protocol heights are `u64`.
     */
    verifyCustodianSignature(event, custodian, height, publicKey) {
        return this._run(() => {
            wasm.verifyCustodianSignature(canonicalJson(event), custodian, String(height), publicKey);
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
