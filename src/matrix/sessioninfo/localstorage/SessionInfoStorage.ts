/*
Copyright 2025 New Vector Ltd.
Copyright 2020 Bruno Windels <bruno@windels.cloud>

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

interface ISessionInfo {
    id: string;
    deviceId: string;
    userId: string;
    homeserver: string;
    homeServer: string; // deprecate this over time
    accessToken: string;
    lastUsed: number;
    /**
     * If true, then this session will not be used for sending
     * encrypted messages.
     * OTK uploads will be disabled when this is true.
     * 
     * Encrypted messages can still be decrypted and key backups
     * can also be restored.
     */
    isReadOnly: boolean;
    /**
     * A workspace's secondary connection: listed and opened only through
     * its workspace (see WorkspaceStorage).
     */
    hidden?: boolean;
}

// todo: this should probably be in platform/types?
interface ISessionInfoStorage {
    getAll(): Promise<ISessionInfo[]>;
    updateLastUsed(id: string, timestamp: number): Promise<void>;
    updateAccessToken(id: string, token: string): Promise<void>;
    update(id: string, patch: Partial<Omit<ISessionInfo, "id">>): Promise<void>;
    get(id: string): Promise<ISessionInfo | undefined>;
    add(sessionInfo: ISessionInfo): Promise<void>;
    delete(sessionId: string): Promise<void>;
}

export class SessionInfoStorage implements ISessionInfoStorage {
    private readonly _name: string;

    constructor(name: string) {
        this._name = name;
    }

    getAll(): Promise<ISessionInfo[]> {
        return Promise.resolve(this._getAllSync());
    }

    private _getAllSync(): ISessionInfo[] {
        const sessionsJson = localStorage.getItem(this._name);
        if (sessionsJson) {
            const sessions = JSON.parse(sessionsJson);
            if (Array.isArray(sessions)) {
                return sessions;
            }
        }
        return [];
    }

    async updateAccessToken(id: string, accessToken: string): Promise<void> {
        const sessions = this._getAllSync();
        const session = sessions.find(session => session.id === id);
        if (!session) {
            throw Error('No session found');
        }
        session.accessToken = accessToken;
        localStorage.setItem(this._name, JSON.stringify(sessions));
    }

    /** Merge `patch` into a session's info, e.g. to hide a workspace's secondary connection. */
    async update(id: string, patch: Partial<Omit<ISessionInfo, "id">>): Promise<void> {
        const sessions = this._getAllSync();
        const session = sessions.find(session => session.id === id);
        if (!session) {
            throw Error('No session found');
        }
        Object.assign(session, patch, {id});
        localStorage.setItem(this._name, JSON.stringify(sessions));
    }

    async updateLastUsed(id: string, timestamp: number): Promise<void> {
        const sessions = this._getAllSync();
        const session = sessions.find(session => session.id === id);
        if (session) {
            session.lastUsed = timestamp;
            localStorage.setItem(this._name, JSON.stringify(sessions));
        }
    }

    async get(id: string): Promise<ISessionInfo | undefined> {
        const sessions = await this.getAll();
        if (sessions) {
            return sessions.find(session => session.id === id);
        }
    }

    async add(sessionInfo: ISessionInfo): Promise<void> {
        const sessions = this._getAllSync();
        sessions.push(sessionInfo);
        localStorage.setItem(this._name, JSON.stringify(sessions));
    }

    async delete(sessionId: string): Promise<void> {
        let sessions = this._getAllSync();
        sessions = sessions.filter(s => s.id !== sessionId);
        localStorage.setItem(this._name, JSON.stringify(sessions));
    }
    
}
