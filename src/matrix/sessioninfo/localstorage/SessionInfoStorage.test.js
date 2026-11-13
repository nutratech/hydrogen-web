/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/* global globalThis */

import {SessionInfoStorage} from "./SessionInfoStorage";

/** A plain stand-in for `localStorage`; the Node test runner has none. */
function memoryBacking(initial = {}) {
    const items = new Map(Object.entries(initial));
    return {items, getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, value)};
}

function installBacking(backing) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    globalThis.localStorage = backing;
    return () => {
        if (previous) {
            Object.defineProperty(globalThis, "localStorage", previous);
        } else {
            delete globalThis.localStorage;
        }
    };
}

function session(id, extra = {}) {
    return {
        id,
        deviceId: `DEVICE_${id}`,
        userId: `@${id}:example.org`,
        homeserver: "https://example.org",
        homeServer: "https://example.org",
        accessToken: `token_${id}`,
        lastUsed: 0,
        isReadOnly: false,
        ...extra,
    };
}

export function tests() {
    return {
        "concurrent add calls keep both sessions": async assert => {
            const restore = installBacking(memoryBacking());
            try {
                const storage = new SessionInfoStorage("sessions");
                await Promise.all([storage.add(session("a")), storage.add(session("b"))]);
                const ids = (await storage.getAll()).map(s => s.id).sort();
                assert.deepEqual(ids, ["a", "b"]);
            } finally {
                restore();
            }
        },
        "concurrent update and updateLastUsed do not lose either change": async assert => {
            const restore = installBacking(memoryBacking());
            try {
                const storage = new SessionInfoStorage("sessions");
                await storage.add(session("a"));
                await Promise.all([
                    storage.update("a", {accessToken: "new"}),
                    storage.updateLastUsed("a", 42),
                ]);
                const stored = await storage.get("a");
                assert.equal(stored.accessToken, "new");
                assert.equal(stored.lastUsed, 42);
            } finally {
                restore();
            }
        },
        "concurrent updateAccessToken and delete keep the storage consistent": async assert => {
            const restore = installBacking(memoryBacking());
            try {
                const storage = new SessionInfoStorage("sessions");
                await storage.add(session("a"));
                await storage.add(session("b"));
                await Promise.all([
                    storage.updateAccessToken("a", "new"),
                    storage.delete("b"),
                ]);
                const sessions = await storage.getAll();
                assert.deepEqual(sessions.map(s => s.id), ["a"]);
                assert.equal(sessions[0].accessToken, "new");
            } finally {
                restore();
            }
        },
    };
}
