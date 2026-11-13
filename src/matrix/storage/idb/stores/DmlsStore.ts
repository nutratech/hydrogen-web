/*
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {Store} from "../Store";

/** AES-GCM envelope for secret material at rest. */
export interface DmlsCiphertext {
    v: number;
    iv: string;
    ct: string;
}

/** One persisted DMLS group blob. `seq` mirrors the wasm blob's sequence number. */
export interface DmlsGroupRecord {
    groupId: string;
    roomId: string;
    seq: number;
    updatedTs: number;
    blob: DmlsCiphertext;
}

/** A single-use KeyPackage's private material, keyed by its public id. */
export interface DmlsKeyPackageRecord {
    keyPackageId: string;
    roomId: string;
    secret: DmlsCiphertext;
    expiresTs?: number;
}

export class DmlsGroupStore {
    private _store: Store<DmlsGroupRecord>;

    constructor(store: Store<DmlsGroupRecord>) {
        this._store = store;
    }

    get(groupId: string): Promise<DmlsGroupRecord | undefined> {
        return this._store.get(groupId);
    }

    /** Every group belonging to a room; a reboot creates a second one. */
    getAllForRoom(roomId: string): Promise<DmlsGroupRecord[]> {
        return this._store.index("byRoom").selectAll(this._store.IDBKeyRange.only(roomId));
    }

    /** The most recently written group for a room, which a reboot supersedes. */
    async getActiveForRoom(roomId: string): Promise<DmlsGroupRecord | undefined> {
        const records = await this.getAllForRoom(roomId);
        return records.reduce((active, record) =>
            !active || record.updatedTs > active.updatedTs ? record : active, undefined);
    }

    set(record: DmlsGroupRecord): void {
        this._store.put(record);
    }

    remove(groupId: string): void {
        this._store.delete(groupId);
    }
}

export class DmlsKeyPackageStore {
    private _store: Store<DmlsKeyPackageRecord>;

    constructor(store: Store<DmlsKeyPackageRecord>) {
        this._store = store;
    }

    get(keyPackageId: string): Promise<DmlsKeyPackageRecord | undefined> {
        return this._store.get(keyPackageId);
    }

    set(record: DmlsKeyPackageRecord): void {
        this._store.put(record);
    }

    remove(keyPackageId: string): void {
        this._store.delete(keyPackageId);
    }

    /** Drop every stored package for a room (leaving or wiping a group). */
    async removeForRoom(roomId: string): Promise<void> {
        const all = await this._store.selectAll(undefined);
        for (const record of all) {
            if (record.roomId === roomId) {
                this._store.delete(record.keyPackageId);
            }
        }
    }
}
