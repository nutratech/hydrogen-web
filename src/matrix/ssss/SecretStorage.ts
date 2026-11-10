/*
Copyright 2025 New Vector Ltd.
Copyright 2020 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/
import type {Key} from "./common";
import type {Platform} from "../../platform/web/Platform.js";
import type {Storage} from "../storage/idb/Storage";
import type {AccountDataEntry} from "../storage/idb/stores/AccountDataStore";

type EncryptedData = {
    iv: string;
    ciphertext: string;
    mac: string;
}

export enum DecryptionFailure {
    NotEncryptedWithKey,
    BadMAC,
    UnsupportedAlgorithm,
}

class DecryptionError extends Error {
    constructor(msg: string, public readonly reason: DecryptionFailure) {
        super(msg);
    }
}

export class SecretStorage {
    private readonly _key: Key;
    private readonly _platform: Platform;
    private readonly _storage: Storage;
    private readonly _hsApi: any;
    private readonly _userId: string;

    constructor({key, platform, storage, hsApi, userId}: {key: Key, platform: Platform, storage: Storage, hsApi: any, userId: string}) {
        this._key = key;
        this._platform = platform;
        this._storage = storage;
        this._hsApi = hsApi;
        this._userId = userId;
    }

    /** this method will auto-commit any indexeddb transaction because of its use of the webcrypto api */
    async hasValidKeyForAnyAccountData(): Promise<boolean> {
        const txn = await this._storage.readTxn([
            this._storage.storeNames.accountData,
        ]);
        const allAccountData = await txn.accountData.getAll();
        for (const accountData of allAccountData) {
            try {
                await this._decryptAccountData(accountData);
                return true; // decryption succeeded
            } catch (err) {
                if (err instanceof DecryptionError && err.reason !== DecryptionFailure.NotEncryptedWithKey) {
                    throw err;
                } else {
                    continue;
                }
            }
        }
        return false;
    }

    /** this method will auto-commit any indexeddb transaction because of its use of the webcrypto api */
    async readSecret(name: string): Promise<string | undefined> {
        const txn = await this._storage.readTxn([
            this._storage.storeNames.accountData,
        ]);
        const accountData = await txn.accountData.get(name);
        if (!accountData) {
            return;
        }
        return await this._decryptAccountData(accountData);
    }

    async writeSecret(name: string, secret: string, log?: object): Promise<void> {
        if (!this._hsApi || !this._userId) {
            throw new Error("secret storage cannot write account data in this session");
        }
        const txn = await this._storage.readTxn([this._storage.storeNames.accountData]);
        const existing = await txn.accountData.get(name);
        // Encrypt under this key only: a ciphertext left under another key would
        // keep serving the old value to devices that unlock with that key.
        const encrypted = {[this._key.id]: await this._encryptAESSecret(name, secret)};
        const content = {...(existing?.content || {}), encrypted};
        await this._hsApi.setAccountData(this._userId, name, content, {log}).response();
        const writeTxn = await this._storage.readWriteTxn([this._storage.storeNames.accountData]);
        try {
            writeTxn.accountData.set({type: name, content});
        } catch (err) {
            writeTxn.abort();
            throw err;
        }
        await writeTxn.complete();
    }

    async _encryptAESSecret(type: string, secret: string): Promise<EncryptedData> {
        const {base64, utf8} = this._platform.encoding;
        const hkdfKey = await this._platform.crypto.derive.hkdf(
            this._key.binaryKey,
            new Uint8Array(8).buffer,
            utf8.encode(type),
            "SHA-256",
            512
        );
        const aesKey = hkdfKey.slice(0, 32);
        const hmacKey = hkdfKey.slice(32);
        const iv = await this._platform.crypto.aes.generateIV();
        const ciphertext = await this._platform.crypto.aes.encryptCTR({
            key: aesKey,
            iv,
            data: utf8.encode(secret),
        });
        const mac = await this._platform.crypto.hmac.compute(hmacKey, ciphertext, "SHA-256");
        return {
            iv: base64.encode(iv),
            ciphertext: base64.encode(ciphertext),
            mac: base64.encode(mac),
        };
    }

    async _decryptAccountData(accountData: AccountDataEntry): Promise<string> {
        const encryptedData = accountData?.content?.encrypted?.[this._key.id] as EncryptedData;
        if (!encryptedData) {
            throw new DecryptionError(`Secret ${accountData.type} is not encrypted for key ${this._key.id}`, DecryptionFailure.NotEncryptedWithKey);
        }

        if (this._key.algorithm === "m.secret_storage.v1.aes-hmac-sha2") {
            return await this._decryptAESSecret(accountData.type, encryptedData);
        } else {
            throw new DecryptionError(`Unsupported algorithm for key ${this._key.id}: ${this._key.algorithm}`, DecryptionFailure.UnsupportedAlgorithm);
        }
    }

    async _decryptAESSecret(type: string, encryptedData: EncryptedData): Promise<string> {
        const {base64, utf8} = this._platform.encoding;
        // now derive the aes and mac key from the 4s key
        const hkdfKey = await this._platform.crypto.derive.hkdf(
            this._key.binaryKey,
            new Uint8Array(8).buffer,   //zero salt
            utf8.encode(type), // info
            "SHA-256",
            512 // 512 bits or 64 bytes
        );
        const aesKey = hkdfKey.slice(0, 32);
        const hmacKey = hkdfKey.slice(32);
        const ciphertextBytes = base64.decode(encryptedData.ciphertext);

        const isVerified = await this._platform.crypto.hmac.verify(
            hmacKey, base64.decode(encryptedData.mac),
            ciphertextBytes, "SHA-256");

        if (!isVerified) {
            throw new DecryptionError("Bad MAC", DecryptionFailure.BadMAC);
        }

        const plaintextBytes = await this._platform.crypto.aes.decryptCTR({
            key: aesKey,
            iv: base64.decode(encryptedData.iv),
            data: ciphertextBytes
        });

        return utf8.decode(plaintextBytes);
    }
}

/* eslint-disable @typescript-eslint/explicit-function-return-type -- test mocks */
export function tests() {
    /** A platform with real WebCrypto, so the write path is checked against the read path. */
    async function platform(): Promise<any> {
        const {webcrypto} = await import("node:crypto");
        const {Crypto} = await import("../../platform/web/dom/Crypto.js");
        const {Encoding} = await import("../../platform/web/utils/Encoding.js");
        const g = globalThis as any;
        const previous = g.window;
        g.window = {crypto: webcrypto};
        try {
            return {crypto: new Crypto(undefined), encoding: new Encoding()};
        } finally {
            g.window = previous;
        }
    }

    function accountDataStorage(initial: Record<string, any> = {}): any {
        const entries = new Map<string, any>(Object.entries(initial).map(([type, content]) => [type, {type, content}]));
        const txn = {
            accountData: {
                get: async (type: string) => entries.get(type),
                set: (entry: any) => entries.set(entry.type, entry),
            },
            complete: async () => {},
            abort: () => {},
        };
        return {entries, storeNames: {accountData: "accountData"}, readTxn: async () => txn, readWriteTxn: async () => txn};
    }

    function key(id: string, byte: number): Key {
        // structural stand-in for Key: SecretStorage only reads these three
        return {id, algorithm: "m.secret_storage.v1.aes-hmac-sha2", binaryKey: new Uint8Array(32).fill(byte)} as unknown as Key;
    }

    function hsApi(): any {
        const sent: any[] = [];
        return {sent, setAccountData: (userId: string, type: string, content: any) => {
            sent.push({userId, type, content});
            return {response: async () => ({})};
        }};
    }

    return {
        "a written secret reads back through the existing decryption path": async (assert: any) => {
            const storage = accountDataStorage();
            const api = hsApi();
            const ssss = new SecretStorage({key: key("k1", 7), platform: await platform(), storage, hsApi: api, userId: "@a:hs"});
            await ssss.writeSecret("m.principal.rotation_key", "ISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISE");
            assert.equal(api.sent[0].type, "m.principal.rotation_key");
            assert.equal(await ssss.readSecret("m.principal.rotation_key"), "ISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISE");
        },
        "a write replaces copies encrypted under other keys": async (assert: any) => {
            const storage = accountDataStorage({"m.principal.rotation_key": {encrypted: {old: {iv: "", ciphertext: "", mac: ""}}}});
            const ssss = new SecretStorage({key: key("k1", 7), platform: await platform(), storage, hsApi: hsApi(), userId: "@a:hs"});
            await ssss.writeSecret("m.principal.rotation_key", "next");
            assert.deepEqual(Object.keys(storage.entries.get("m.principal.rotation_key").content.encrypted), ["k1"]);
        },
        "another key cannot read the secret": async (assert: any) => {
            const storage = accountDataStorage();
            const p = await platform();
            await new SecretStorage({key: key("k1", 7), platform: p, storage, hsApi: hsApi(), userId: "@a:hs"}).writeSecret("s", "value");
            const entry = storage.entries.get("s");
            entry.content.encrypted.k2 = entry.content.encrypted.k1;
            await assert.rejects(new SecretStorage({key: key("k2", 9), platform: p, storage}).readSecret("s"));
        },
    };
}
/* eslint-enable @typescript-eslint/explicit-function-return-type */
