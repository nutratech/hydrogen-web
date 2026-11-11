/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {ViewModel} from "../../ViewModel";

/**
 * Shown for a room whose owning connection has no live session (the account
 * is still starting, has lost its login, or its server is unreachable). Room
 * routing fails closed, so this replaces the room rather than showing another
 * connection's stale copy of it.
 */
export class UnavailableRoomViewModel extends ViewModel {
    constructor(options) {
        super(options);
        this.roomId = options.roomId;
        this._closeUrl = this.urlRouter.urlUntilSegment("session");
    }

    get closeUrl() {
        return this._closeUrl;
    }

    get kind() {
        return "unavailable";
    }
}
