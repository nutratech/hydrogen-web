/*
Copyright 2025 New Vector Ltd.
Copyright 2022 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {ViewModel, Options as BaseOptions} from "../ViewModel";
import {SegmentType} from "../navigation/index";
import type {Session} from "../../matrix/Session.js";
import {joinRoom, joinRoomWith} from "../../matrix/room/joinRoom";

type Options = BaseOptions & {
    session: Session;
};

export class JoinRoomViewModel extends ViewModel<SegmentType, Options> {
    private _session: Session;
    private _joinInProgress: boolean = false;
    private _error: Error | undefined;
    private _closeUrl: string;
    private _withCygnus: boolean = false;

    constructor(options: Readonly<Options>) {
        super(options);
        this._session = options.session;
        this._closeUrl = this.urlRouter.urlUntilSegment("session");
        const cygnus = this._session.cygnus;
        if (cygnus) {
            this.track(cygnus.identity.subscribe(() => this.emitChange("canUseCygnus")));
            cygnus.load().then(() => this.emitChange("canUseCygnus"), err => this.logger.log({l: "cygnus load failed"}).catch(err));
        }
    }

    /** True when the user can join with their MSC00FC principal. */
    get canUseCygnus(): boolean {
        const cygnus = this._session.cygnus;
        return !!cygnus?.isSupported && !!cygnus.identity.get();
    }

    get withCygnus(): boolean { return this._withCygnus && this.canUseCygnus; }

    setWithCygnus(withCygnus: boolean): void {
        this._withCygnus = withCygnus;
        this.emitChange("withCygnus");
    }

    get closeUrl(): string { return this._closeUrl; }

    async join(roomId: string, via: string[] = []): Promise<void> {
        this._error = undefined;
        this._joinInProgress = true;
        this.emitChange("joinInProgress");
        try {
            const id = this.withCygnus
                ? await this._joinWithCygnus(roomId, via)
                : await joinRoom(roomId, this._session);
            this.navigation.push("room", id);
        }
        catch (e) {
            this._error = e;
            this._joinInProgress = false;
            this.emitChange("error");
        }
    }

    private async _joinWithCygnus(roomId: string, via: string[]): Promise<string> {
        // Device-signed events cite a room ID; aliases would need resolving first.
        if (!roomId.startsWith("!")) {
            throw new Error("Joining with a portable identity needs a room ID (!…), not an alias.");
        }
        return joinRoomWith(roomId, this._session,
            () => this.logger.run("cygnus join room", log => this._session.cygnus.joinRoom(roomId, log, via)));
    }

    get joinInProgress(): boolean {
        return this._joinInProgress;
    }

    get status(): string | undefined {
        if (this._error) {
            return this._error.message;
        } 
        else if(this._joinInProgress){
            return "Joining room";
        }
        return undefined;
    }
}
