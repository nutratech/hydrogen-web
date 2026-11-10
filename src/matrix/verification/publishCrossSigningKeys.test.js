/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/* global Buffer -- Node-only test: Ed25519 via node:crypto */
import anotherjson from "another-json";
import {buildCrossSigningUpload, publishCrossSigningKeys} from "./publishCrossSigningKeys.js";

/** Ed25519 from node:crypto, as a `signer` over 32-byte seeds and unpadded base64. */
async function nodeSigner() {
    const {createPrivateKey, createPublicKey, sign} = await import("node:crypto");
    const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
    const privateKey = seed => createPrivateKey({key: Buffer.concat([pkcs8Prefix, Buffer.from(seed)]), format: "der", type: "pkcs8"});
    const unpadded = buffer => buffer.toString("base64").replace(/=+$/, "");
    return {
        publicKey: seed => unpadded(createPublicKey(privateKey(seed)).export({format: "der", type: "spki"}).subarray(-32)),
        sign: (seed, message) => unpadded(sign(null, Buffer.from(message), privateKey(seed))),
    };
}

async function verify(publicKey, message, signature) {
    const {createPublicKey, verify: verifySignature} = await import("node:crypto");
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const key = createPublicKey({key: Buffer.concat([spkiPrefix, Buffer.from(publicKey, "base64")]), format: "der", type: "spki"});
    return verifySignature(null, Buffer.from(message), key, Buffer.from(signature, "base64"));
}

const seeds = {
    master: new Uint8Array(32).fill(1),
    self_signing: new Uint8Array(32).fill(2),
    user_signing: new Uint8Array(32).fill(3),
};
const USER = "@alice:new.tld";

function request(status, body) {
    return {response: async () => body, responseCode: async () => status};
}

/** A homeserver that publishes uploaded keys after password UIA (or without it when `uia` is false). */
function homeserver({uia = true, password = "pw", published = {}} = {}) {
    const uploads = [];
    const state = {master_keys: published.master_keys, self_signing_keys: published.self_signing_keys};
    const hsApi = {
        uploads,
        queryKeys: () => request(200, state),
        uploadCrossSigningKeys: body => {
            uploads.push(body);
            if (uia && !body.auth) {
                return request(401, {session: "s1", flows: [{stages: ["m.login.password"]}]});
            }
            if (uia && (body.auth.password !== password || body.auth.session !== "s1")) {
                return request(401, {errcode: "M_FORBIDDEN"});
            }
            state.master_keys = {[USER]: body.master_key};
            state.self_signing_keys = {[USER]: body.self_signing_key};
            return request(200, {});
        },
    };
    return hsApi;
}

export function tests() {
    return {
        "the subkeys are signed by the master key over their canonical JSON": async assert => {
            const signer = await nodeSigner();
            const upload = buildCrossSigningUpload(USER, seeds, signer);
            const master = signer.publicKey(seeds.master);
            assert.deepEqual(upload.master_key, {user_id: USER, usage: ["master"], keys: {[`ed25519:${master}`]: master}});
            for (const field of ["self_signing_key", "user_signing_key"]) {
                const {signatures, ...unsigned} = upload[field];
                assert(await verify(master, anotherjson.stringify(unsigned), signatures[USER][`ed25519:${master}`]));
            }
            assert.equal(upload.self_signing_key.usage[0], "self_signing");
            assert.equal(Object.values(upload.user_signing_key.keys)[0], signer.publicKey(seeds.user_signing));
        },
        "publishes through password UIA and confirms with keys/query": async assert => {
            const signer = await nodeSigner();
            const hsApi = homeserver();
            const result = await publishCrossSigningKeys({hsApi, userId: USER, password: "pw", seeds, signer});
            assert.equal(result.uploaded, true);
            assert.equal(hsApi.uploads.length, 2);
            assert.deepEqual(hsApi.uploads[1].auth, {
                type: "m.login.password", identifier: {type: "m.id.user", user: USER}, password: "pw", session: "s1",
            });
        },
        "does nothing when the account already publishes the same keys": async assert => {
            const signer = await nodeSigner();
            const upload = buildCrossSigningUpload(USER, seeds, signer);
            const hsApi = homeserver({published: {
                master_keys: {[USER]: upload.master_key}, self_signing_keys: {[USER]: upload.self_signing_key},
            }});
            const result = await publishCrossSigningKeys({hsApi, userId: USER, password: "pw", seeds, signer});
            assert.equal(result.uploaded, false);
            assert.equal(hsApi.uploads.length, 0);
        },
        "reports a refused password": async assert => {
            const signer = await nodeSigner();
            const hsApi = homeserver();
            await assert.rejects(publishCrossSigningKeys({hsApi, userId: USER, password: "wrong", seeds, signer}), /refused the password/);
        },
        "refuses when the server offers no password flow": async assert => {
            const signer = await nodeSigner();
            const hsApi = homeserver();
            hsApi.uploadCrossSigningKeys = () => request(401, {session: "s1", flows: [{stages: ["m.login.sso"]}]});
            await assert.rejects(publishCrossSigningKeys({hsApi, userId: USER, password: "pw", seeds, signer}), /does not offer password/);
        },
        "requires all three keys": async assert => {
            const signer = await nodeSigner();
            assert.throws(() => buildCrossSigningUpload(USER, {master: seeds.master, self_signing: seeds.self_signing}, signer), /user_signing/);
        },
    };
}
