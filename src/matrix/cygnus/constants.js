/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/** Room version for MSC00FC (Cygnus) rooms: room v12 plus self-certifying identities. */
export const CYGNUS_ROOM_VERSION = "tk.nutra.cygnus.1";

/** Principals are a sigil (`~` server, `@` user) plus 43 base64url characters, with no `:domain`. */
// The final base64url character has only four meaningful bits for 32 bytes.
const PRINCIPAL_RE = /^[~@][A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export function isCygnusRoomVersion(roomVersion) {
    return roomVersion === CYGNUS_ROOM_VERSION;
}

/**
 * True for a Cygnus principal such as `@Cl5rPGgj2s7J...`. Unlike a Matrix ID it has
 * no localpart/domain split, so callers must not `split(":")` it.
 */
export function isPrincipal(id) {
    return typeof id === "string" && id.length === 44 && PRINCIPAL_RE.test(id);
}
