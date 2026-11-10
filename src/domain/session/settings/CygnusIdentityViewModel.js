/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {ViewModel} from "../../ViewModel";

export const CygnusStatus = Object.freeze({
    Loading: "loading",
    Unsupported: "unsupported",
    NoIdentity: "noIdentity",
    Ready: "ready",
});

/** Settings panel for the account's MSC00FC principal: create it, inspect it, rotate it. */
export class CygnusIdentityViewModel extends ViewModel {
    constructor(options) {
        super(options);
        this._cygnus = options.cygnus;
        this._loaded = false;
        this._busy = false;
        this._error = undefined;
        this.track(this._cygnus.identity.subscribe(() => this.emitChange()));
        this._cygnus.load().then(
            () => { this._loaded = true; this.emitChange(); },
            err => { this._loaded = true; this._error = err.message; this.emitChange(); },
        );
    }

    get status() {
        if (!this._loaded) return CygnusStatus.Loading;
        if (!this._cygnus.isSupported) return CygnusStatus.Unsupported;
        return this._identity ? CygnusStatus.Ready : CygnusStatus.NoIdentity;
    }

    get _identity() { return this._cygnus.identity.get(); }
    get principal() { return this._identity?.principal; }
    get displayUserId() { return this._identity?.displayUserId; }
    get custodian() { return this._identity?.custodian; }
    get height() { return this._identity?.height; }
    get deviceId() { return this._identity?.deviceId; }
    get hasPendingRotation() { return !!this._identity?.hasPendingRotation; }
    get isBusy() { return this._busy; }
    get error() { return this._error; }

    createIdentity() {
        return this._run("cygnus create identity", log => this._cygnus.createIdentity(log));
    }

    /** Also used to resend a rotation that was signed but not confirmed. */
    rotate() {
        return this._run("cygnus rotate", log => this._cygnus.rotate(log));
    }

    async _run(name, fn) {
        if (this._busy) return;
        this._busy = true;
        this._error = undefined;
        this.emitChange();
        try {
            await this.logger.run(name, fn);
        } catch (err) {
            this._error = err.message;
        } finally {
            this._busy = false;
            this.emitChange();
        }
    }
}
