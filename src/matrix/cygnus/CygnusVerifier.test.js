/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {CygnusVerifier} from "./CygnusVerifier.js";
import {isCygnusRoomVersion, isPrincipal} from "./constants.js";

// Fixtures from the MSC00FC vectors (pid_vectors.json Appendix A, pid_pdu_vectors.json P1).
const A0 = "AQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACn43blzT6rgsVNzZYO7Q2Rty6Gui6qDEtLT9KTxg_8UIqI4910CfGV_VLbLTy6XXLKZwm_HZQSG_N0iAG0D29cABBjaGF0LmV4YW1wbGUub3Jn2Q1TtCiz1ePkElNMfK781u9YMaFhnLO0hG8z6K_y2aSahTHRknkQ8MVLscIBbzf0LtD98Jfza5nXkVQuh_K0CQ";
const A1 = "AQGygRTH2GK15mgvH07AEn3j4YK5WsOSxdE6Qhi4ufwtvQAAAAAAAAABsoEUx9hiteZoLx9OwBJ94-GCuVrDksXROkIYuLn8Lb01Nmw5cTdJ5i-8iyk2_ucSDxdQdO6gPdbzTa9bC_blH-1JKMYo0cLG6ukDOJBZlWEpWSc6XGP5NjbBRhSshzfRABBjaGF0LmV4YW1wbGUub3JngTl3Dqh9F19Wo1Rmw0x-zMuNipG07jeiXfYPW4_Js5SxA7F2pH-iNJh8RCmwbClk188UfWoteisDrefjnO4Wcxjg6D_r5fzgWl4cY8xqkAxfEuhqoj3hZQxNf3P2ZfkK";
const CREATE_PDU = {"type":"m.room.create","sender":"@Cl5rPGgj2s7JHMwFxSEOHfFYM_K0PDpnhXEMYwMgQuo","content":{"room_version":"tk.nutra.cygnus.1","creator_links":{"server":["AQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACn43blzT6rgsVNzZYO7Q2Rty6Gui6qDEtLT9KTxg_8UIqI4910CfGV_VLbLTy6XXLKZwm_HZQSG_N0iAG0D29cABBjaGF0LmV4YW1wbGUub3Jn2Q1TtCiz1ePkElNMfK781u9YMaFhnLO0hG8z6K_y2aSahTHRknkQ8MVLscIBbzf0LtD98Jfza5nXkVQuh_K0CQ","AQGygRTH2GK15mgvH07AEn3j4YK5WsOSxdE6Qhi4ufwtvQAAAAAAAAABsoEUx9hiteZoLx9OwBJ94-GCuVrDksXROkIYuLn8Lb01Nmw5cTdJ5i-8iyk2_ucSDxdQdO6gPdbzTa9bC_blH-1JKMYo0cLG6ukDOJBZlWEpWSc6XGP5NjbBRhSshzfRABBjaGF0LmV4YW1wbGUub3JngTl3Dqh9F19Wo1Rmw0x-zMuNipG07jeiXfYPW4_Js5SxA7F2pH-iNJh8RCmwbClk188UfWoteisDrefjnO4Wcxjg6D_r5fzgWl4cY8xqkAxfEuhqoj3hZQxNf3P2ZfkK"],"user":["AQIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4kBxguvojRXkm6JtORb1xDcBb37XlTZ9vN8bcmesKPLKBFMfYYrXmaC8fTsASfePhgrlaw5LF0TpCGLi5_C29AW4ywZdB8K-CYGEq6Z_RPYo4lEci4Ilk3SOXOPVSphU7ABdAYWxpY2U6Y2hhdC5leGFtcGxlLm9yZw"]}},"origin_server_ts":1792860000001,"depth":1,"prev_events":[],"auth_events":[],"state_key":"","device_certificate":{"version":1,"device_id":"TEST51","device_key":"IBLLkMpg6OXY2vZuInLSIz4EhtVX6MZhQe2JIBd9frc","self_signing_key":"wFDFY3pE-oYp__PMzOIwDLNipj2Z2V_FQUUmb0MyRFo","self_signing_signature":"ys_tG6Q3JAG5v3krZ4L5TLouhSjJU81Pm_H0hHKTq7FbAQ_Rl-0tZv_uapVujfIdUcWTp7bTrSAFv-SQ2uBoCA","device_key_signature":"7zYaOIuKCsgcOt4tMIAuhAm7OSMjCyzFSE0oQcq1jkAuhrecPh6pwjIv5ydMvxInav5awswxeXXxz_OzaALKBg"},"hashes":{"sha256":"e5NpEDDw1KZbA9D9bbrQ2dbGRfdz3R0TMUb6Ak_lcSo"},"signatures":{"@Cl5rPGgj2s7JHMwFxSEOHfFYM_K0PDpnhXEMYwMgQuo":{"ed25519:TEST51":"sU9DMTt-NT6yDX9SpJWeN0YRWUK7RYj4kPhEVy0zN9PNm_PZJUdU_3XCVcSTpZdnOs9panZeL1EXN3RAk3_kDg"},"~soEUx9hiteZoLx9OwBJ94-GCuVrDksXROkIYuLn8Lb0":{"ed25519:1":"QHSLkH65P9dFeDgiTDVZvYc3UAmPjHf5nJXmBeZmV_oJZFxH1D25lr_AZ7E7wFrj2rlLrZ8zqmUrFqN6mdr7BQ"}}};
const CREATE_EVENT_ID = "$30zU4L44nR8z-TbH4R7So2CfI9UJzMYnMhzY9NKHXgY";

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

export function tests(wasmBytes) {
    return {
        "unloaded verifier reports an error instead of throwing": assert => {
            const result = new CygnusVerifier().verifyChain([A0]);
            assert.equal(result.ok, false);
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
            assert.equal(verifier.verifyEventId(CREATE_PDU, CREATE_EVENT_ID).ok, true);
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
            assert(isPrincipal("~soEUx9hiteZoLx9OwBJ94-GCuVrDksXROkIYuLn8Lb0"));
            assert(!isPrincipal("@alice:example.org"));
            assert(!isPrincipal("@Cl5rPGgj2s7JHMwFxSEOHfFYM_K0PDpnhXEMYwMgQuo="));
        },
        "recognises the Cygnus room version": assert => {
            assert(isCygnusRoomVersion("tk.nutra.cygnus.1"));
            assert(!isCygnusRoomVersion("12"));
        },
    };
}
