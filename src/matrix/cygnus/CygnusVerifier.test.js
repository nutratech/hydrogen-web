/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {CygnusVerifier} from "./CygnusVerifier.js";
import {isCygnusRoomVersion, isPrincipal} from "./constants.js";

// Fixtures from the MSC00FC vectors (pid_vectors.json Appendix A, pid_pdu_vectors.json P1).
const A0 = "AQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB_LjVaIv-BYnAih7bnqYkqlByvjgze1oFBXRvUvcl0b4qI4910CfGV_VLbLTy6XXLKZwm_HZQSG_N0iAG0D29cABBjaGF0LmV4YW1wbGUub3JnCK-nYNDic0Z89Ec_a2PGm3aq70QCRMlNp6PWikK9QAAUe3uL7tSPsdpcdmItB3XSgmkl9uP7p5zRTfGF1hfVDw";
const A1 = "AQHUCt4cY_sK_sQxmSETcKGd8f-ZHqmoOYEv0I-kGvzvIAAAAAAAAAAB1AreHGP7Cv7EMZkhE3ChnfH_mR6pqDmBL9CPpBr87yCKugXi5WhUkH8s2il7gpcAwEd6SJBdTaBMuPyGTjjVY-1JKMYo0cLG6ukDOJBZlWEpWSc6XGP5NjbBRhSshzfRABBjaGF0LmV4YW1wbGUub3JngTl3Dqh9F19Wo1Rmw0x-zMuNipG07jeiXfYPW4_Js5R_TYGHVQw9Gxe6s_WWRrk0LN-Up85Q5Mi6p5VlMumtQT01Mg8_o3W8rUuTCtPEbLFP5_Ck_aN1STehH6yNT54C";
const CREATE_PDU = {"type":"m.room.create","sender":"@dI_Nb8pazMUMAWyJ4zMFDtJnftNKYwQu2puGEkPBcKY","content":{"room_version":"tk.nutra.cygnus.12","creator_links":{"server":["AQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB_LjVaIv-BYnAih7bnqYkqlByvjgze1oFBXRvUvcl0b4qI4910CfGV_VLbLTy6XXLKZwm_HZQSG_N0iAG0D29cABBjaGF0LmV4YW1wbGUub3JnCK-nYNDic0Z89Ec_a2PGm3aq70QCRMlNp6PWikK9QAAUe3uL7tSPsdpcdmItB3XSgmkl9uP7p5zRTfGF1hfVDw","AQHUCt4cY_sK_sQxmSETcKGd8f-ZHqmoOYEv0I-kGvzvIAAAAAAAAAAB1AreHGP7Cv7EMZkhE3ChnfH_mR6pqDmBL9CPpBr87yCKugXi5WhUkH8s2il7gpcAwEd6SJBdTaBMuPyGTjjVY-1JKMYo0cLG6ukDOJBZlWEpWSc6XGP5NjbBRhSshzfRABBjaGF0LmV4YW1wbGUub3JngTl3Dqh9F19Wo1Rmw0x-zMuNipG07jeiXfYPW4_Js5R_TYGHVQw9Gxe6s_WWRrk0LN-Up85Q5Mi6p5VlMumtQT01Mg8_o3W8rUuTCtPEbLFP5_Ck_aN1STehH6yNT54C"],"user":["AQIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABy6iILWoFoOE2EAX0t6CZlC2DPbWvaHgkZZa_PY5nW-tQK3hxj-wr-xDGZIRNwoZ3x_5keqag5gS_Qj6Qa_O8gAW4ywZdB8K-CYGEq6Z_RPYo4lEci4Ilk3SOXOPVSphU7ABdAYWxpY2U6Y2hhdC5leGFtcGxlLm9yZw"]}},"origin_server_ts":1792860000001,"depth":1,"prev_events":[],"auth_events":[],"state_key":"","device_certificate":{"version":1,"device_id":"TEST51","device_key":"IBLLkMpg6OXY2vZuInLSIz4EhtVX6MZhQe2JIBd9frc","self_signing_key":"wFDFY3pE-oYp__PMzOIwDLNipj2Z2V_FQUUmb0MyRFo","self_signing_signature":"jY_9z20kgLxE4ag-qiXuD_wXeCsCKjjzY49ItPQAbpK3KM9QghFgMFCbQ4IHR9M4uLoC7Z2oBfRiUa6WFKmKBg","device_key_signature":"9jPVzQV28IWgOM_ItaoNXOrQYp1y_juiRIdFyU6aNC4IZHuHVTDEi4qZY5YGuVcrHSYOvH7xJKoEe8v6pOTRCA"},"hashes":{"sha256":"3CRD0CBobAd-_qbXZo2N_IH4HYXaa_fwq3Kx7qz_Whg"},"signatures":{"@dI_Nb8pazMUMAWyJ4zMFDtJnftNKYwQu2puGEkPBcKY":{"ed25519:TEST51":"7RiXmiSJDdfoCLVxKQFySJMKBYyNSNH84yXWJ2fUGK-WTJliLWZ8P03pRdRi7cY0uERmbsEYsF3SdaiINcK2DQ"},"~1AreHGP7Cv7EMZkhE3ChnfH_mR6pqDmBL9CPpBr87yA":{"ed25519:1":"jiJUVRi6EGAEvamHJlwMbihMnCevXRD2WdH0CFLiMGocQQU8xfJGRTATVJgaecVce3krU9Fv-vsBqfVHZgikCA"}}};
const CREATE_EVENT_ID = "$y-unWYpPuzqBtWq4z60NsTmFMytlbZr7QwkGJZ8oENM";

async function wasmBinary() {
    // Node has no `fetch` for file: URLs, so read the binary directly there.
    const {readFile} = await import("node:fs/promises");
    return readFile(new URL("./wasm/cygnus_wasm_bg.wasm", import.meta.url));
}

async function loadedVerifier() {
    const verifier = new CygnusVerifier();
    await verifier.load(await wasmBinary());
    return verifier;
}

export function tests() {
    return {
        "unloaded verifier reports an error instead of throwing": assert => {
            const result = new CygnusVerifier().verifyChain([A0]);
            assert.equal(result.ok, false);
        },
        "rejects a different wasm source on every instance": async assert => {
            const verifier = await loadedVerifier();
            const other = new Uint8Array([0, 97, 115, 109]);
            await assert.rejects(verifier.load(other));
            await assert.rejects(new CygnusVerifier().load(other));
            await verifier.load(await wasmBinary());
        },
        "verifies a server link chain": async assert => {
            const verifier = await loadedVerifier();
            const result = verifier.verifyChain([A0, A1]);
            assert.equal(result.ok, true);
            assert(result.principal.startsWith("~"));
        },
        "rejects a chain without its genesis": async assert => {
            const verifier = await loadedVerifier();
            assert.equal(verifier.verifyChain([A1]).ok, false);
        },
        "computes the event ID of the create event": async assert => {
            const verifier = await loadedVerifier();
            assert.equal(verifier.eventId(CREATE_PDU).eventId, CREATE_EVENT_ID);
            const reordered = {signatures: CREATE_PDU.signatures, hashes: CREATE_PDU.hashes, state_key: CREATE_PDU.state_key, auth_events: CREATE_PDU.auth_events, prev_events: CREATE_PDU.prev_events, depth: CREATE_PDU.depth, origin_server_ts: CREATE_PDU.origin_server_ts, content: CREATE_PDU.content, sender: CREATE_PDU.sender, type: CREATE_PDU.type, device_certificate: CREATE_PDU.device_certificate};
            assert.equal(verifier.eventId(reordered).eventId, CREATE_EVENT_ID);
            assert.equal(verifier.verifyEventId(CREATE_PDU, CREATE_EVENT_ID).ok, true);
        },
        "verifies a device signature and rejects a wrong certified key": async assert => {
            const verifier = await loadedVerifier();
            const cert = CREATE_PDU.device_certificate;
            assert.equal(verifier.verifyDeviceSignature(CREATE_PDU, CREATE_PDU.sender, cert.device_id, cert.device_key).ok, true);
            assert.equal(verifier.verifyDeviceSignature(CREATE_PDU, CREATE_PDU.sender, cert.device_id, A0.slice(1, 44)).ok, false);
        },
        "verifies a custodian signature at a height": async assert => {
            const verifier = await loadedVerifier();
            const server = "~1AreHGP7Cv7EMZkhE3ChnfH_mR6pqDmBL9CPpBr87yA";
            const key = "7UkoxijRwsbq6QM4kFmVYSlZJzpcY_k2NsFGFKyHN9E";
            assert.equal(verifier.verifyCustodianSignature(CREATE_PDU, server, 1, key).ok, true);
            assert.equal(verifier.verifyCustodianSignature(CREATE_PDU, server, 0, key).ok, false);
            assert.equal(verifier.verifyCustodianSignature(CREATE_PDU, server, 1, A0.slice(1, 44)).ok, false);
        },
        "flags an event whose content does not match its ID": async assert => {
            const verifier = await loadedVerifier();
            const tampered = {...CREATE_PDU, origin_server_ts: CREATE_PDU.origin_server_ts + 1};
            assert.equal(verifier.verifyEventId(tampered, CREATE_EVENT_ID).ok, false);
        },
        "rejects padded principals": async assert => {
            const verifier = await loadedVerifier();
            const good = verifier.verifyChain([A0]).principal;
            assert.equal(verifier.parsePrincipal(good).ok, true);
            assert.equal(verifier.parsePrincipal(good + "=").ok, false);
        },
        "recognises principals but not Matrix IDs": assert => {
            assert(isPrincipal("@Cl5rPGgj2s7JHMwFxSEOHfFYM_K0PDpnhXEMYwMgQuo"));
            assert(isPrincipal("~CM1u95QHafQfFW6nrQ0T--AP1ovvab7NTTniwta_dE4"));
            assert(!isPrincipal("@alice:example.org"));
            assert(!isPrincipal("@Cl5rPGgj2s7JHMwFxSEOHfFYM_K0PDpnhXEMYwMgQuo="));
            assert(!isPrincipal("@Cl5rPGgj2s7JHMwFxSEOHfFYM_K0PDpnhXEMYwMgQup"));
            assert(!isPrincipal("@Cl5rPGgj2s7JHMwFxSEOHfFYM_K0PDpnhXEMYwMgQuo\n"));
        },
        "recognises the Cygnus room version": assert => {
            assert(isCygnusRoomVersion("tk.nutra.cygnus.12"));
            assert(!isCygnusRoomVersion("tk.nutra.cygnus.1"));
            assert(!isCygnusRoomVersion("12"));
        },
    };
}
