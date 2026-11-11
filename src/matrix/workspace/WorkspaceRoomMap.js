/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {BaseObservableMap} from "../../observable/map";

/**
 * One of a session's room maps (rooms, invites or rooms being created), merged
 * across every live connection of a workspace, for the one room list.
 *
 * With `byOwner`, a key is taken only from the connection that owns it, so a
 * room both accounts are in is listed once, from its owner. Without it (rooms
 * being created, whose local IDs have no owner yet) every connection's entries
 * are listed, the source's first.
 *
 * Connections arrive and leave, and rooms change owner, while the list is
 * shown. Those changes are applied as removes and adds of the affected keys,
 * never as a reset: in this codebase a reset tells subscribers that the map
 * is now empty (`SortedMapList` and `MappedMap` do not repopulate after one).
 */
export class WorkspaceRoomMap extends BaseObservableMap {
    /**
     * @param {import("./RoomRouter.js").RoomRouter} router
     * @param {(session: object) => BaseObservableMap} select e.g. `s => s.rooms`
     * @param {{byOwner?: boolean}} [options]
     */
    constructor(router, select, {byOwner = true} = {}) {
        super();
        this._router = router;
        this._select = select;
        this._byOwner = byOwner;
        this._current = null;
        this._sourceSubscriptions = [];
        this._routerSubscription = null;
    }

    _accepts(connectionId, key) {
        return !this._byOwner || this._router.ownerOf(key) === connectionId;
    }

    /** The value for `key` as the live connections hold it now. */
    _valueFor(key) {
        for (const [connectionId, session] of this._router.liveSessions()) {
            const value = this._select(session)?.get(key);
            if (value && this._accepts(connectionId, key)) {
                return value;
            }
        }
        return undefined;
    }

    _compute() {
        const result = new Map();
        for (const [connectionId, session] of this._router.liveSessions()) {
            const map = this._select(session);
            if (!map) {
                continue;
            }
            for (const [key, value] of map) {
                if (!result.has(key) && this._accepts(connectionId, key)) {
                    result.set(key, value);
                }
            }
        }
        return result;
    }

    onSubscribeFirst() {
        this._current = this._compute();
        this._subscribeSources();
        this._routerSubscription = this._router.subscribeChanges(() => this._resync());
        super.onSubscribeFirst();
    }

    onUnsubscribeLast() {
        super.onUnsubscribeLast();
        this._unsubscribeSources();
        this._routerSubscription?.();
        this._routerSubscription = null;
        this._current = null;
    }

    _subscribeSources() {
        this._sourceSubscriptions = this._router.liveSessions()
            .map(([connectionId, session]) => [connectionId, this._select(session)])
            .filter(([, map]) => map)
            .map(([connectionId, map]) => map.subscribe(this._handlerFor(connectionId)));
    }

    _unsubscribeSources() {
        for (const unsubscribe of this._sourceSubscriptions) {
            unsubscribe();
        }
        this._sourceSubscriptions = [];
    }

    _handlerFor(connectionId) {
        return {
            onAdd: (key, value) => {
                if (!this._current.has(key) && this._accepts(connectionId, key)) {
                    this._current.set(key, value);
                    this.emitAdd(key, value);
                }
            },
            onUpdate: (key, value, params) => {
                if (this._current.get(key) === value) {
                    this.emitUpdate(key, value, params);
                }
            },
            onRemove: (key, value) => {
                if (this._current.get(key) !== value) {
                    return;
                }
                this._current.delete(key);
                this.emitRemove(key, value);
                const replacement = this._valueFor(key);
                if (replacement) {
                    this._current.set(key, replacement);
                    this.emitAdd(key, replacement);
                }
            },
            onReset: () => this._resync(),
        };
    }

    /** Re-read every connection after one came or went or a room changed owner; emit only the differences. */
    _resync() {
        if (!this._current) {
            return;
        }
        this._unsubscribeSources();
        const next = this._compute();
        const previous = this._current;
        this._current = next;
        for (const [key, value] of previous) {
            if (next.get(key) !== value) {
                this.emitRemove(key, value);
            }
        }
        for (const [key, value] of next) {
            if (previous.get(key) !== value) {
                this.emitAdd(key, value);
            }
        }
        this._subscribeSources();
    }

    get(key) {
        return this._current ? this._current.get(key) : this._valueFor(key);
    }

    get size() {
        return (this._current ?? this._compute()).size;
    }

    [Symbol.iterator]() {
        return (this._current ?? this._compute()).entries();
    }
}
