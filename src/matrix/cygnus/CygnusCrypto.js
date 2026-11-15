/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import * as wasm from "./wasm/cygnus_wasm.js";
import anotherjson from "another-json";
import {CygnusVerifier} from "./CygnusVerifier.js";

/** Unpadded base64url, the encoding MSC00FC uses for keys, seeds and links. */
export function toBase64Url(bytes) {
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The 32-byte root of a principal (`~…` or `@…`), as unpadded base64url. */
export function principalRoot(principal) {
    return principal.slice(1);
}

/**
 * Client-side MSC00FC operations: everything the verifier does, plus the
 * signing half a device needs (identity bootstrap, device certificates,
 * event signing and user chain advancement).
 *
 * Unlike the verifier, signing methods throw: they sit inside flows that must
 * stop on the first failure, not behind a trust indicator. Seeds are 32-byte
 * Ed25519 seeds as unpadded base64url and never leave this process except to
 * local storage.
 */
export class CygnusCrypto extends CygnusVerifier {
    /**
     * @param {(bytes: Uint8Array) => Uint8Array} getRandomValues CSPRNG fill, e.g. `crypto.getRandomValues.bind(crypto)`
     */
    constructor(getRandomValues) {
        super();
        this._getRandomValues = getRandomValues;
    }

    /** A fresh 32-byte Ed25519 seed. */
    generateSeed() {
        return toBase64Url(this._getRandomValues(new Uint8Array(32)));
    }

    publicKey(seed) {
        return this._call(() => wasm.publicKey(seed));
    }

    /**
     * Decode one link without verifying it: `{kind, height, principal,
     * custodian, master_key, display_user_id, server_name, online_key}`, with
     * `height` as a decimal string. Pair with `verifyChain` before trusting it.
     */
    parseLink(link) {
        return JSON.parse(this._call(() => wasm.parseLink(link)));
    }

    /** `C = commitment(K_rot)` for the rotation key with this seed (§2.1). */
    rotationCommitment(rotationSeed) {
        return this._call(() => wasm.rotationCommitment(rotationSeed));
    }

    /**
     * Check a `POST /principal` response (§7) against what was requested.
     * @returns {string} the verified genesis link
     */
    verifyUserPrincipalResponse(rotationSeed, masterKey, principal, links) {
        return this._call(() => wasm.verifyUserPrincipalResponse(rotationSeed, masterKey, principal, links));
    }

    /** The `device_certificate` object for `deviceSeed`, certified master → self-signing → device (§5.2.1). */
    createDeviceCertificate(principal, masterSeed, selfSigningSeed, deviceId, deviceSeed) {
        return JSON.parse(this._call(() => wasm.createDeviceCertificate(principal, masterSeed, selfSigningSeed, deviceId, deviceSeed)));
    }

    /**
     * Set the content hash and add the device signature. The event must
     * already carry its `device_certificate`; the custodian adds its own
     * signature after `send_signed`.
     */
    signEvent(event, sender, deviceId, deviceSeed) {
        return JSON.parse(this._call(() => wasm.signEvent(anotherjson.stringify(event), sender, deviceId, deviceSeed)));
    }

    /**
     * Sign the next user link with the rotation key the parent committed to,
     * committing in turn to `nextRotationSeed`.
     * @param {string} custodian the custodian's `~` principal
     */
    userSuccessor(parentLink, currentRotationSeed, nextRotationSeed, custodian, masterKey, displayUserId) {
        return this._call(() => wasm.userSuccessor(parentLink, currentRotationSeed, nextRotationSeed, principalRoot(custodian), masterKey, displayUserId));
    }

    _call(fn) {
        if (!this._loaded) {
            throw new Error("cygnus wasm not loaded");
        }
        return fn();
    }
}
