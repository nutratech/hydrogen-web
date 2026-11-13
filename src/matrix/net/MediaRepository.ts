/*
Copyright 2025 New Vector Ltd.
Copyright 2020 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { encodeQueryParams } from "./common";
import { decryptAttachment } from "../e2ee/attachment.js";
import { Platform } from "../../platform/web/Platform.js";
import { BlobHandle } from "../../platform/web/dom/BlobHandle.js";
import type {
    Attachment,
    EncryptedFile,
    VersionResponse,
} from "./types/response";

type ServerVersions = VersionResponse["versions"];

type Params = {
    homeserver: string;
    sessionId?: string;
    platform: Platform;
    serverVersions: ServerVersions;
};

export class MediaRepository {
    private readonly homeserver: string;
    private readonly sessionId?: string;
    private readonly platform: Platform;
    // Depends on whether the server supports authenticated media
    private mediaUrlPart: string;

    constructor(params: Params) {
        this.homeserver = params.homeserver;
        this.sessionId = params.sessionId;
        this.platform = params.platform;
        this.generateMediaUrl(params.serverVersions);
    }

    /**
     * Calculate and store the correct media endpoint depending
     * on whether the homeserver supports authenticated media (MSC3916)
     * @see https://github.com/matrix-org/matrix-spec-proposals/pull/3916
     * @param serverVersions List of supported spec versions
     */
    private generateMediaUrl(serverVersions: ServerVersions) {
        const VERSION_WITH_AUTHENTICATION = "v1.11";
        if (serverVersions.includes(VERSION_WITH_AUTHENTICATION)) {
            this.mediaUrlPart = "_matrix/client/v1/media";
        } else {
            this.mediaUrlPart = "_matrix/media/v3";
        }
    }

    mxcUrlThumbnail(
        url: string,
        width: number,
        height: number,
        method: "crop" | "scale"
    ): string | undefined {
        const parts = this.parseMxcUrl(url);
        if (parts) {
            const [serverName, mediaId] = parts;
            const httpUrl = `${this.homeserver}/${
                this.mediaUrlPart
            }/thumbnail/${encodeURIComponent(serverName)}/${encodeURIComponent(
                mediaId
            )}`;
            const mediaUrl = (
                httpUrl +
                "?" +
                encodeQueryParams({
                    width: Math.round(width),
                    height: Math.round(height),
                    method,
                })
            );
            return this.withSessionId(mediaUrl);
        }
        return undefined;
    }

    mxcUrl(url: string): string | undefined {
        const parts = this.parseMxcUrl(url);
        if (parts) {
            const [serverName, mediaId] = parts;
            return this.withSessionId(`${this.homeserver}/${
                this.mediaUrlPart
            }/download/${encodeURIComponent(serverName)}/${encodeURIComponent(
                mediaId
            )}`);
        }
        return undefined;
    }

    private withSessionId(url: string): string {
        if (!this.sessionId || !url.includes("/_matrix/client/v1/media/")) {
            return url;
        }
        const separator = url.includes("?") ? "&" : "?";
        return `${url}${separator}_hydrogen_session_id=${encodeURIComponent(this.sessionId)}`;
    }

    private parseMxcUrl(url: string): string[] | undefined {
        const prefix = "mxc://";
        if (url.startsWith(prefix)) {
            return url.slice(prefix.length).split("/", 2);
        } else {
            return undefined;
        }
    }

    async downloadEncryptedFile(
        fileEntry: EncryptedFile,
        cache: boolean = false
    ): Promise<BlobHandle> {
        const url = this.mxcUrl(fileEntry.url);
        const { body: encryptedBuffer } = await this.platform
            .request(url, { method: "GET", format: "buffer", cache })
            .response();
        const decryptedBuffer = await decryptAttachment(
            this.platform,
            encryptedBuffer,
            fileEntry
        );
        return this.platform.createBlob(decryptedBuffer, fileEntry.mimetype);
    }

    async downloadPlaintextFile(
        mxcUrl: string,
        mimetype: string,
        cache: boolean = false
    ): Promise<BlobHandle> {
        const url = this.mxcUrl(mxcUrl);
        const { body: buffer } = await this.platform
            .request(url, { method: "GET", format: "buffer", cache })
            .response();
        return this.platform.createBlob(buffer, mimetype);
    }

    async downloadAttachment(
        content: Attachment,
        cache: boolean = false
    ): Promise<BlobHandle> {
        if (content.file) {
            return this.downloadEncryptedFile(content.file, cache);
        } else {
            return this.downloadPlaintextFile(
                content.url!,
                content.info?.mimetype,
                cache
            );
        }
    }
}

export function tests() {
    return {
        "Uses correct endpoint when server supports authenticated media": (
            assert
        ) => {
            const homeserver = "matrix.org";
            const platform = {};
            // Is it enough to check if v1.11 is present?
            // or do we check if maxVersion > v1.11
            const serverVersions = ["v1.1", "v1.11", "v1.10"];
            const mediaRepository = new MediaRepository({
                homeserver,
                platform,
                serverVersions,
            });

            const mxcUrl = "mxc://matrix.org/foobartest";
            assert.match(
                mediaRepository.mxcUrl(mxcUrl),
                /_matrix\/client\/v1\/media/
            );
        },

        "does not add a session selector to legacy media URLs":
            (assert) => {
                const homeserver = "matrix.org";
                const platform = {};
                const serverVersions = ["v1.1", "v1.10"];
                const mediaRepository = new MediaRepository({
                    homeserver,
                    sessionId: "session-1",
                    platform,
                    serverVersions,
                });

                const mxcUrl = "mxc://matrix.org/foobartest";
                assert.match(mediaRepository.mxcUrl(mxcUrl), /_matrix\/media\/v3/);
                assert.doesNotMatch(mediaRepository.mxcUrl(mxcUrl), /_hydrogen_session_id/);
            },

        "selects the owning session for authenticated media URLs": assert => {
            const mediaRepository = new MediaRepository({
                homeserver: "https://matrix.org",
                sessionId: "destination/session",
                platform: {},
                serverVersions: ["v1.11"],
            });
            assert.match(mediaRepository.mxcUrl("mxc://matrix.org/file"), /_hydrogen_session_id=destination%2Fsession/);
            assert.match(mediaRepository.mxcUrlThumbnail("mxc://matrix.org/file", 50, 50, "scale"), /_hydrogen_session_id=destination%2Fsession/);
            },
    };
}
