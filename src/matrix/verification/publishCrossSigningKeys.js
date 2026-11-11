/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import anotherjson from "another-json";

/**
 * Publishing existing cross-signing keys on another account.
 *
 * A Cygnus principal is bound to its account's cross-signing master key
 * (MSC00FC §5.2.1), so when a workspace connects a second account (the move
 * destination) that account must publish the same master, self-signing and
 * user-signing keys. Unlike a cross-signing reset, nothing is generated here:
 * the private seeds come from the source account's secret storage.
 *
 * Signing goes through `signer`, `{publicKey(seed), sign(seed, message)}` over
 * unpadded base64 strings, so tests can use any Ed25519 implementation;
 * `olmSigner` adapts Olm's `PkSigning`.
 */

const USAGES = ["master", "self_signing", "user_signing"];

/** Olm's `PkSigning` as a `signer`. Seeds are 32 raw bytes. */
export function olmSigner(olm) {
    const withKey = (seed, fn) => {
        const signing = new olm.PkSigning();
        try {
            return fn(signing, signing.init_with_seed(seed));
        } finally {
            signing.free();
        }
    };
    return {
        publicKey: seed => withKey(seed, (_, publicKey) => publicKey),
        sign: (seed, message) => withKey(seed, signing => signing.sign(message)),
    };
}

function crossSigningKey(userId, usage, publicKey) {
    return {user_id: userId, usage: [usage], keys: {[`ed25519:${publicKey}`]: publicKey}};
}

/** Sign `key` with the master key, as `/keys/device_signing/upload` requires for the subkeys. */
function signWithMaster(key, userId, masterSeed, masterPublicKey, signer) {
    const signature = signer.sign(masterSeed, anotherjson.stringify(key));
    return {...key, signatures: {[userId]: {[`ed25519:${masterPublicKey}`]: signature}}};
}

/**
 * The `/keys/device_signing/upload` body (without `auth`) for these seeds.
 * @param {{master: Uint8Array, self_signing: Uint8Array, user_signing: Uint8Array}} seeds
 */
export function buildCrossSigningUpload(userId, seeds, signer) {
    for (const usage of USAGES) {
        if (!seeds[usage]) {
            throw new Error(`the ${usage} cross-signing key is missing`);
        }
    }
    const masterPublicKey = signer.publicKey(seeds.master);
    return {
        master_key: crossSigningKey(userId, "master", masterPublicKey),
        self_signing_key: signWithMaster(
            crossSigningKey(userId, "self_signing", signer.publicKey(seeds.self_signing)),
            userId, seeds.master, masterPublicKey, signer),
        user_signing_key: signWithMaster(
            crossSigningKey(userId, "user_signing", signer.publicKey(seeds.user_signing)),
            userId, seeds.master, masterPublicKey, signer),
    };
}

function publishedKey(keys, userId) {
    return Object.values(keys?.[userId]?.keys || {});
}

/** True when the account already publishes exactly these master and self-signing keys. */
export async function hasPublishedCrossSigningKeys({hsApi, userId, masterKey, selfSigningKey, userSigningKey, log}) {
    const response = await hsApi.queryKeys({device_keys: {[userId]: []}}, {log}).response();
    return publishedKey(response.master_keys, userId).includes(masterKey) &&
        publishedKey(response.self_signing_keys, userId).includes(selfSigningKey) &&
        // the server returns an account's own user-signing key only to that account
        (!userSigningKey || publishedKey(response.user_signing_keys, userId).includes(userSigningKey));
}

/**
 * Publish `seeds` as `userId`'s cross-signing keys, authenticating with the
 * account password through user-interactive auth, then confirm with
 * `/keys/query` that the server now returns them.
 *
 * Does nothing when the account already publishes the same master and
 * self-signing and user-signing keys, so a retried move does not ask the server to replace
 * them. Throws when the server offers no password flow.
 */
export async function publishCrossSigningKeys({hsApi, userId, password, seeds, signer, log}) {
    const upload = buildCrossSigningUpload(userId, seeds, signer);
    const masterKey = signer.publicKey(seeds.master);
    const selfSigningKey = signer.publicKey(seeds.self_signing);
    const userSigningKey = signer.publicKey(seeds.user_signing);
    if (await hasPublishedCrossSigningKeys({hsApi, userId, masterKey, selfSigningKey, userSigningKey, log})) {
        return {uploaded: false};
    }
    const first = hsApi.uploadCrossSigningKeys(upload, {log});
    const firstResponse = await first.response();
    if (await first.responseCode() === 401) {
        if (firstResponse.errcode && !firstResponse.flows) {
            throw new Error(`the homeserver rejected publishing cross-signing keys (${firstResponse.errcode})`);
        }
        const flows = firstResponse.flows || [];
        if (!flows.some(flow => flow.stages?.length === 1 && flow.stages[0] === "m.login.password")) {
            throw new Error("the homeserver does not offer password authentication for publishing cross-signing keys");
        }
        const second = hsApi.uploadCrossSigningKeys({
            ...upload,
            auth: {
                type: "m.login.password",
                identifier: {type: "m.id.user", user: userId},
                password,
                session: firstResponse.session,
            },
        }, {log});
        const secondResponse = await second.response();
        if (await second.responseCode() === 401) {
            throw new Error(`the homeserver refused the password for publishing cross-signing keys${
                secondResponse.errcode ? ` (${secondResponse.errcode})` : ""}`);
        }
    }
    if (!await hasPublishedCrossSigningKeys({hsApi, userId, masterKey, selfSigningKey, userSigningKey, log})) {
        throw new Error("the homeserver accepted the cross-signing keys but does not publish them");
    }
    return {uploaded: true};
}
