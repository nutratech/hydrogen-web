/*
Copyright 2025 New Vector Ltd.
Copyright 2021 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {MemberChange, RoomMember, EVENT_TYPE as MEMBER_EVENT_TYPE} from "../../members/RoomMember.js";
import {LRUCache} from "../../../../utils/LRUCache";
import {isCygnusRoomVersion} from "../../../cygnus/constants.js";

const USER_EPOCH_EVENT_TYPE = "m.room.user_epoch";

function isValidEpochHeight(height) {
    return Number.isSafeInteger(height) && height >= 0;
}

/**
 * Whether `event.sender` may speak for the principal it names. Only the
 * principal itself qualifies. MSC00FC §5.3 also lets any joined member relay a
 * newer epoch, but a relay is only authentic if its `links` verify against the
 * principal's previously held tip, which needs the chain state that the
 * verification-status work adds. Until then a relayed epoch is ignored and
 * the member shows as its principal. A `sender` is a user ID, so a custodian
 * (`~…`) can never be the sender and `content.custodian` proves nothing.
 */
export function isTrustedEpochSender(event) {
    return typeof event?.sender === "string" && event.sender === event.state_key;
}

function copyMemberWithDisplayName(member, displayName, epochHeight) {
    return new RoomMember({
        roomId: member.roomId,
        userId: member.userId,
        membership: member.membership,
        avatarUrl: member.avatarUrl,
        displayName,
        cygnusDisplayName: displayName,
        cygnusEpochHeight: epochHeight,
    });
}

/**
 * Keep the newest epoch-derived name. A member event without an epoch (a
 * profile change, leave or rejoin) must not revert a name learned earlier, and
 * a replayed older epoch must not replace a newer one.
 */
function mergeEpoch(existing, incoming) {
    const existingName = existing.cygnusDisplayName;
    if (existingName === undefined) {
        return incoming;
    }
    const existingHeight = existing.cygnusEpochHeight;
    const incomingName = incoming.cygnusDisplayName;
    const incomingHeight = incoming.cygnusEpochHeight;
    if (incomingName === undefined || !isValidEpochHeight(incomingHeight)) {
        return copyMemberWithDisplayName(incoming, existingName, existingHeight);
    }
    if (!isValidEpochHeight(existingHeight) || incomingHeight >= existingHeight) {
        return incoming;
    }
    return copyMemberWithDisplayName(incoming, existingName, existingHeight);
}

export class MemberWriter {
    constructor(roomId, isCygnusRoom = () => false) {
        this._roomId = roomId;
        this._isCygnusRoom = isCygnusRoom;
        this._cache = new LRUCache(5, member => member.userId);
    }

    prepareMemberSync(stateEvents, timelineEvents, hasFetchedMembers) {
        return new MemberSync(this, stateEvents, timelineEvents, hasFetchedMembers);
    }

    async _writeMember(member, txn) {
        let existingMember = this._cache.get(member.userId);
        if (!existingMember) {
            const memberData = await txn.roomMembers.get(this._roomId, member.userId);
            if (memberData) {
                existingMember = new RoomMember(memberData);
            }
        }
        const memberToWrite = existingMember ? mergeEpoch(existingMember, member) : member;
        // either never heard of the member, or something changed
        if (!existingMember || !existingMember.equals(memberToWrite)) {
            txn.roomMembers.set(memberToWrite.serialize());
            this._cache.set(memberToWrite);
            return new MemberChange(memberToWrite, existingMember?.membership);
        }
    }

    async lookupMember(userId, txn) {
        let member = this._cache.get(userId);
        if (!member) {
            const memberData = await txn.roomMembers.get(this._roomId, userId);
            if (memberData) {
                member = new RoomMember(memberData);
                this._cache.set(member);
            }
        }
        return member;
    }
}

/** Represents the member changes in a given sync.
 *  Used to write the changes to storage and historical member
 *  information for events in the same sync.
 **/
export class MemberSync {
    constructor(memberWriter, stateEvents, timelineEvents, hasFetchedMembers) {
        this._memberWriter = memberWriter;
        this._timelineEvents = timelineEvents;
        this._hasFetchedMembers = hasFetchedMembers;
        this._newStateMembers = null;
        // Cygnus principals are keyed by principal; the display name lives in
        // the principal's m.room.user_epoch rather than on the member event.
        this._epochDisplayNames = new Map();
        // The newest epoch from the state section applies to the whole timeline,
        // while a timeline epoch only applies to later events in the same sync.
        this._stateEpochDisplayNames = new Map();
        this._timelineEpochs = new Map();
        this._collectEpochDisplayNames(stateEvents, false);
        this._collectEpochDisplayNames(timelineEvents, true);
        if (stateEvents) {
            this._newStateMembers = this._stateEventsToMembers(stateEvents);
        }
    }

    _collectEpochDisplayNames(events, fromTimeline) {
        if (!Array.isArray(events) || (!this._memberWriter._isCygnusRoom() && !events.some(event =>
            event?.type === "m.room.create" && isCygnusRoomVersion(event.content?.room_version)))) {
            return;
        }
        for (let index = 0; index < events.length; index++) {
            const event = events[index];
            const principal = event?.state_key;
            const displayName = event?.content?.display_user_id;
            if (event?.type !== USER_EPOCH_EVENT_TYPE ||
                typeof principal !== "string" || typeof displayName !== "string" || !displayName) {
                continue;
            }
            if (!isTrustedEpochSender(event)) {
                // a third party's claim about who someone is; never apply it
                console.warn(`ignoring ${USER_EPOCH_EVENT_TYPE} for ${principal} sent by ${event.sender}`);
                continue;
            }
            const height = event.content?.height;
            if (!isValidEpochHeight(height)) {
                // a malformed height must not be able to replace a valid epoch
                continue;
            }
            const epoch = {displayName, height};
            const current = this._epochDisplayNames.get(principal);
            if (!current || height >= current.height) {
                this._epochDisplayNames.set(principal, epoch);
            }
            if (fromTimeline) {
                let epochs = this._timelineEpochs.get(principal);
                if (!epochs) {
                    epochs = [];
                    this._timelineEpochs.set(principal, epochs);
                }
                epochs.push({index, ...epoch});
            } else {
                const currentState = this._stateEpochDisplayNames.get(principal);
                if (!currentState || height >= currentState.height) {
                    this._stateEpochDisplayNames.set(principal, epoch);
                }
            }
        }
    }

    _withEpochDisplayName(member) {
        if (!member) {
            return member;
        }
        const epoch = this._epochDisplayNames.get(member.userId);
        if (!epoch) {
            return member;
        }
        if (member.displayName === epoch.displayName &&
            member.cygnusEpochHeight === epoch.height &&
            member.cygnusDisplayName === epoch.displayName) {
            return member;
        }
        return copyMemberWithDisplayName(member, epoch.displayName, epoch.height);
    }

    _withEventEpochDisplayName(member, userId, event) {
        if (!member) {
            return member;
        }
        let epoch = this._stateEpochDisplayNames.get(userId);
        const eventIndex = this._timelineEvents?.findIndex(candidate => candidate.event_id === event.event_id) ?? -1;
        const end = eventIndex === -1 ? this._timelineEvents?.length ?? 0 : eventIndex;
        for (const candidate of this._timelineEpochs.get(userId) ?? []) {
            if (candidate.index >= end) {
                break;
            }
            if (!epoch || candidate.height >= epoch.height) {
                epoch = candidate;
            }
        }
        return epoch ? copyMemberWithDisplayName(member, epoch.displayName, epoch.height) : member;
    }

    get _roomId() {
        return this._memberWriter._roomId;
    }

    _stateEventsToMembers(stateEvents) {
        let members;
        for (const event of stateEvents) {
            if (event.type === MEMBER_EVENT_TYPE) {
                const member = RoomMember.fromMemberEvent(this._roomId, event);
                if (member) {
                    if (!members) {
                        members = new Map();
                    }
                    members.set(member.userId, member);
                }
            }
        }
        return members;
    }

    _timelineEventsToMembers(timelineEvents) {
        let members;
        // iterate backwards to only add the last member in the timeline
        for (let i = timelineEvents.length - 1; i >= 0; i--) {
            const e = timelineEvents[i];
            const userId = e.state_key;
            if (e.type === MEMBER_EVENT_TYPE && !members?.has(userId)) {
                const member = RoomMember.fromMemberEvent(this._roomId, e);
                if (member) {
                    if (!members) {
                        members = new Map();
                    }
                    members.set(member.userId, member);
                }
            }
        }
        return members;
    }

    async lookupMemberAtEvent(userId, event, txn) {
        let member;
        if (this._timelineEvents) {
            member = this._findPrecedingMemberEventInTimeline(userId, event);
            if (member) {
                return member;
            }
        }
        member = this._newStateMembers?.get(userId);
        if (member) {
            return this._withEventEpochDisplayName(member, userId, event);
        }
        return await this._memberWriter.lookupMember(userId, txn);
    }

    async write(txn) {
        const memberChanges = new Map();
        const writtenMembers = new Set();
        let newTimelineMembers;
        if (this._timelineEvents) {
            newTimelineMembers = this._timelineEventsToMembers(this._timelineEvents);
        }
        if (this._newStateMembers) {
            for (const member of this._newStateMembers.values()) {
                if (!newTimelineMembers?.has(member.userId)) {
                    writtenMembers.add(member.userId);
                    const memberChange = await this._memberWriter._writeMember(
                        this._withEpochDisplayName(member), txn);
                    if (memberChange) {
                        // if the member event appeared only in the state section,
                        // AND we haven't heard about it AND we haven't fetched all members yet (to avoid #470),
                        // this may be a lazy loading member (if it's not in a gap, we are certain
                        // it is a ll member, in a gap, we can't tell), so we pass in our own membership as
                        // as the previous one so we won't consider it a join to not have false positives (to avoid #192).
                        // see also MemberChange.hasJoined
                        const maybeLazyLoadingMember = !this._hasFetchedMembers && !memberChange.previousMembership;
                        if (maybeLazyLoadingMember) {
                            memberChange.previousMembership = member.membership;
                        }
                        memberChanges.set(memberChange.userId, memberChange);
                    }
                }
            }
        }
        if (newTimelineMembers) {
            for (const member of newTimelineMembers.values()) {
                writtenMembers.add(member.userId);
                const memberChange = await this._memberWriter._writeMember(
                    this._withEpochDisplayName(member), txn);
                if (memberChange) {
                    memberChanges.set(memberChange.userId, memberChange);
                }
            }
        }
        // A user epoch can arrive in a sync without a member event of its own.
        // Refresh the stored member so the new display_user_id is shown.
        for (const [userId, {displayName, height}] of this._epochDisplayNames) {
            if (writtenMembers.has(userId)) {
                continue;
            }
            const member = await this._memberWriter.lookupMember(userId, txn);
            if (!member || (member.cygnusDisplayName === displayName && member.cygnusEpochHeight === height)) {
                continue;
            }
            const memberChange = await this._memberWriter._writeMember(
                copyMemberWithDisplayName(member, displayName, height), txn);
            if (memberChange) {
                memberChanges.set(memberChange.userId, memberChange);
            }
        }
        return memberChanges;
    }

    // try to find the first member event before the given event,
    // so we respect historical display names within the chunk of timeline
    _findPrecedingMemberEventInTimeline(userId, event) {
        let eventIndex = -1;
        for (let i = this._timelineEvents.length - 1; i >= 0; i--) {
            const e = this._timelineEvents[i];
            if (e.event_id === event.event_id) {
                eventIndex = i;
                break;
            }
        }
        for (let i = eventIndex - 1; i >= 0; i--) {
            const e = this._timelineEvents[i];
            if (e.type === MEMBER_EVENT_TYPE && e.state_key === userId) {
                const member = RoomMember.fromMemberEvent(this._roomId, e);
                if (member) {
                    return this._withEventEpochDisplayName(member, userId, event);
                }
            }
        }
    }
}

export function tests() {

    let idCounter = 0;

    function createMemberEvent(membership, userId, displayName, avatarUrl) {
        idCounter += 1;
        return {
            content: {
                membership,
                "displayname": displayName,
                "avatar_url": avatarUrl
            },
            event_id: `$${idCounter}`,
            sender: userId,
            "state_key": userId,
            type: "m.room.member"
        };
    }

    function createStorage(initialMembers = []) {
        const members = new Map();
        for (const m of initialMembers) {
            members.set(m.userId, m);
        }
        return {
            members,
            roomMembers: {
                async get(_, userId) {
                    return members.get(userId);
                },
                set(member) {
                    members.set(member.userId, member);
                }
            }
        }
    }

    function member(...args) {
        return RoomMember.fromMemberEvent(roomId, createMemberEvent.apply(null, args));
    }

    function cygnusWriter() {
        return new MemberWriter(roomId, () => true);
    }

    const roomId = "abc";
    const alice = "@alice:hs.tld";
    const avatar = "mxc://hs.tld/def";

    return {
        "new join": async assert => {
            const writer = new MemberWriter(roomId);
            const txn = createStorage();
            const memberSync = writer.prepareMemberSync([], [createMemberEvent("join", alice)], false);
            const changes = await memberSync.write(txn);
            assert.equal(changes.size, 1);
            const change = changes.get(alice);
            assert(change.hasJoined);
            assert.equal(txn.members.get(alice).membership, "join");
        },
        "accept invite": async assert => {
            const writer = new MemberWriter(roomId);
            const txn = createStorage([member("invite", alice)]);
            const memberSync = writer.prepareMemberSync([], [createMemberEvent("join", alice)], false);
            const changes = await memberSync.write(txn);
            assert.equal(changes.size, 1);
            const change = changes.get(alice);
            assert.equal(change.previousMembership, "invite");
            assert(change.hasJoined);
            assert.equal(txn.members.get(alice).membership, "join");
        },
        "change display name": async assert => {
            const writer = new MemberWriter(roomId);
            const txn = createStorage([member("join", alice, "Alice")]);
            const memberSync = writer.prepareMemberSync([], [createMemberEvent("join", alice, "Alies")], false);
            const changes = await memberSync.write(txn);
            assert.equal(changes.size, 1);
            const change = changes.get(alice);
            assert(!change.hasJoined);
            assert.equal(change.member.displayName, "Alies");
            assert.equal(txn.members.get(alice).displayName, "Alies");
        },
        "set avatar": async assert => {
            const writer = new MemberWriter(roomId);
            const txn = createStorage([member("join", alice, "Alice")]);
            const memberSync = writer.prepareMemberSync([], [createMemberEvent("join", alice, "Alice", avatar)], false);
            const changes = await memberSync.write(txn);
            assert.equal(changes.size, 1);
            const change = changes.get(alice);
            assert(!change.hasJoined);
            assert.equal(change.member.avatarUrl, avatar);
            assert.equal(txn.members.get(alice).avatarUrl, avatar);
        },
        "ignore redundant member event in timeline": async assert => {
            const writer = new MemberWriter(roomId);
            const txn = createStorage([member("join", alice, "Alice", avatar)]);
            const memberSync = writer.prepareMemberSync([], [createMemberEvent("join", alice, "Alice", avatar)], false);
            const changes = await memberSync.write(txn);
            assert.equal(changes.size, 0);
        },
        "ignore redundant member event in state": async assert => {
            const writer = new MemberWriter(roomId);
            const txn = createStorage([member("join", alice, "Alice", avatar)]);
            const memberSync = writer.prepareMemberSync([createMemberEvent("join", alice, "Alice", avatar)], [], false);
            const changes = await memberSync.write(txn);
            assert.equal(changes.size, 0);
        },
        "leave": async assert => {
            const writer = new MemberWriter(roomId);
            const txn = createStorage([member("join", alice, "Alice")]);
            const memberSync = writer.prepareMemberSync([], [createMemberEvent("leave", alice, "Alice")], false);
            const changes = await memberSync.write(txn);
            assert.equal(changes.size, 1);
            const change = changes.get(alice);
            assert(change.hasLeft);
            assert(!change.hasJoined);
        },
        "ban": async assert => {
            const writer = new MemberWriter(roomId);
            const txn = createStorage([member("join", alice, "Alice")]);
            const memberSync = writer.prepareMemberSync([], [createMemberEvent("ban", alice, "Alice")], false);
            const changes = await memberSync.write(txn);
            assert.equal(changes.size, 1);
            const change = changes.get(alice);
            assert(change.hasLeft);
            assert(!change.hasJoined);
        },
        "reject invite": async assert => {
            const writer = new MemberWriter(roomId);
            const txn = createStorage([member("invite", alice, "Alice")]);
            const memberSync = writer.prepareMemberSync([], [createMemberEvent("leave", alice, "Alice")], false);
            const changes = await memberSync.write(txn);
            assert.equal(changes.size, 1);
            const change = changes.get(alice);
            assert(!change.hasLeft);
            assert(!change.hasJoined);
        },
        "lazy loaded member we already know about doens't return change": async assert => {
            const writer = new MemberWriter(roomId);
            const txn = createStorage([member("join", alice, "Alice")]);
            const memberSync = writer.prepareMemberSync([createMemberEvent("join", alice, "Alice")], [], false);
            const changes = await memberSync.write(txn);
            assert.equal(changes.size, 0);
        },
        "lazy loaded member we already know about changes display name": async assert => {
            const writer = new MemberWriter(roomId);
            const txn = createStorage([member("join", alice, "Alice")]);
            const memberSync = writer.prepareMemberSync([createMemberEvent("join", alice, "Alies")], [], false);
            const changes = await memberSync.write(txn);
            assert.equal(changes.size, 1);
            const change = changes.get(alice);
            assert(!change.hasJoined);
            assert.equal(change.member.displayName, "Alies");
        },
        "unknown lazy loaded member returns change, but not considered a join": async assert => {
            const writer = new MemberWriter(roomId);
            const txn = createStorage();
            const memberSync = writer.prepareMemberSync([createMemberEvent("join", alice, "Alice")], [], false);
            const changes = await memberSync.write(txn);
            assert.equal(changes.size, 1);
            const change = changes.get(alice);
            assert(!change.hasJoined);
            assert(!change.hasLeft);
            assert.equal(change.member.membership, "join");
            assert.equal(txn.members.get(alice).displayName, "Alice");
        },
        "new join through both timeline and state": async assert => {
            const writer = new MemberWriter(roomId);
            const txn = createStorage();
            const aliceJoin = createMemberEvent("join", alice, "Alice");
            const memberSync = writer.prepareMemberSync([aliceJoin], [aliceJoin], false);
            const changes = await memberSync.write(txn);
            assert.equal(changes.size, 1);
            const change = changes.get(alice);
            assert(change.hasJoined);
            assert(!change.hasLeft);
        },
        "change display name in timeline with lazy loaded member in state": async assert => {
            const writer = new MemberWriter(roomId);
            const txn = createStorage();
            const memberSync = writer.prepareMemberSync(
                [createMemberEvent("join", alice, "Alice")],
                [createMemberEvent("join", alice, "Alies")],
                false);
            const changes = await memberSync.write(txn);
            assert.equal(changes.size, 1);
            const change = changes.get(alice);
            assert(change.hasJoined);
            assert(!change.hasLeft);
            assert.equal(change.member.displayName, "Alies");
        },
        "lookupMemberAtEvent returns closest member in the past": async assert => {
            const event1 = createMemberEvent("join", alice, "Alice");
            const event2 = createMemberEvent("join", alice, "Alies");
            const event3 = createMemberEvent("join", alice, "Alys");
            const events = [event1, event2, event3];
            // we write first because the MemberWriter assumes it is called before
            // the SyncWriter does any lookups
            const writer = new MemberWriter(roomId);
            const txn = createStorage();
            const memberSync = await writer.prepareMemberSync([], events, false);
            let member = await memberSync.lookupMemberAtEvent(event1.sender, event1, txn);
            assert.equal(member, undefined);
            member = await memberSync.lookupMemberAtEvent(event2.sender, event2, txn);
            assert.equal(member.displayName, "Alice");
            member = await memberSync.lookupMemberAtEvent(event3.sender, event3, txn);
            assert.equal(member.displayName, "Alies");

            assert.equal(txn.members.size, 0);
            const changes = await memberSync.write(txn);
            assert.equal(txn.members.size, 1);
            assert.equal(changes.size, 1);
            const change = changes.get(alice);
            assert(change.hasJoined);
        },
        "lookupMemberAtEvent falls back on state event": async assert => {
            const event1 = createMemberEvent("join", alice, "Alice");
            const event2 = createMemberEvent("join", alice, "Alies");
            // we write first because the MemberWriter assumes it is called before
            // the SyncWriter does any lookups
            const writer = new MemberWriter(roomId);
            const txn = createStorage();
            const memberSync = await writer.prepareMemberSync([event1], [event2], false);
            const member = await memberSync.lookupMemberAtEvent(event2.sender, event2, txn);
            assert.equal(member.displayName, "Alice");

            assert.equal(txn.members.size, 0);
            const changes = await memberSync.write(txn);
            assert.equal(txn.members.size, 1);
            assert.equal(changes.size, 1);
            const change = changes.get(alice);
            assert(change.hasJoined);
        },
        "write works without event arrays": async assert => {
            const writer = new MemberWriter(roomId);
            const txn = createStorage();
            const memberSync = await writer.prepareMemberSync(undefined, undefined, false);
            const changes = await memberSync.write(txn);
            assert.equal(changes.size, 0);
        },
        "Cygnus member display name comes from the user epoch": async assert => {
            const writer = cygnusWriter();
            const txn = createStorage();
            const memberEvent = createMemberEvent("join", alice);
            const epoch = createEpochEvent(alice, "@alice:hs.tld", 0);
            const memberSync = writer.prepareMemberSync([memberEvent, epoch], [], false);
            const changes = await memberSync.write(txn);
            assert.equal(changes.size, 1);
            assert.equal(changes.get(alice).member.displayName, "@alice:hs.tld");
            assert.equal(txn.members.get(alice).displayName, "@alice:hs.tld");
        },
        "a later user epoch updates a stored member without a member event": async assert => {
            const writer = cygnusWriter();
            const txn = createStorage([member("join", alice, "@alice:old.tld")]);
            const epoch = createEpochEvent(alice, "@alice:new.tld", 1);
            const memberSync = writer.prepareMemberSync([epoch], [], false);
            const changes = await memberSync.write(txn);
            assert.equal(changes.size, 1);
            assert.equal(changes.get(alice).member.displayName, "@alice:new.tld");
            assert.equal(txn.members.get(alice).displayName, "@alice:new.tld");
        },
        "an older user epoch does not override a newer one": async assert => {
            const writer = cygnusWriter();
            const txn = createStorage();
            const memberEvent = createMemberEvent("join", alice);
            const memberSync = writer.prepareMemberSync([
                memberEvent,
                createEpochEvent(alice, "@alice:new.tld", 2),
                createEpochEvent(alice, "@alice:old.tld", 1),
            ], [], false);
            await memberSync.write(txn);
            assert.equal(txn.members.get(alice).displayName, "@alice:new.tld");
        },
        "a later member event without an epoch keeps the epoch display name": async assert => {
            const writer = cygnusWriter();
            const stored = new RoomMember({
                roomId, userId: alice, membership: "join",
                displayName: "@alice:hs.tld",
                cygnusDisplayName: "@alice:hs.tld",
                cygnusEpochHeight: 2,
            });
            const txn = createStorage([stored]);
            const memberSync = writer.prepareMemberSync([], [createMemberEvent("join", alice)], false);
            await memberSync.write(txn);
            assert.equal(txn.members.get(alice).displayName, "@alice:hs.tld");
            assert.equal(txn.members.get(alice).cygnusEpochHeight, 2);
        },
        "an epoch sent by a third party for someone else is ignored": async assert => {
            const writer = cygnusWriter();
            const txn = createStorage([]);
            const mallory = "@MMMMPGgj2s7JHMwFxSEOHfFYM_K0PDpnhXEMYwMgQuo";
            const memberSync = writer.prepareMemberSync([
                createMemberEvent("join", alice),
                createEpochEvent(alice, "@ceo:bank.tld", 1, mallory),
            ], [], false);
            await memberSync.write(txn);
            assert.notEqual(txn.members.get(alice).displayName, "@ceo:bank.tld");
            assert.equal(txn.members.get(alice).cygnusDisplayName, undefined);
        },
        "naming a custodian does not let a third party apply an epoch": async assert => {
            const writer = cygnusWriter();
            const txn = createStorage([]);
            const mallory = "@MMMMPGgj2s7JHMwFxSEOHfFYM_K0PDpnhXEMYwMgQuo";
            for (const custodian of [mallory, "~C5H4UbcebozcY45_S9uOF3u5JQ4mzE22Q3o7FXUwino"]) {
                const memberSync = writer.prepareMemberSync([
                    createMemberEvent("join", alice),
                    createEpochEvent(alice, "@ceo:bank.tld", 1, mallory, {custodian}),
                ], [], false);
                await memberSync.write(txn);
                assert.equal(txn.members.get(alice).cygnusDisplayName, undefined);
            }
        },
        "a replayed older epoch does not replace a stored newer one": async assert => {
            const writer = cygnusWriter();
            const stored = new RoomMember({
                roomId, userId: alice, membership: "join",
                displayName: "@alice:new.tld",
                cygnusDisplayName: "@alice:new.tld",
                cygnusEpochHeight: 2,
            });
            const txn = createStorage([stored]);
            const memberSync = writer.prepareMemberSync([
                createEpochEvent(alice, "@alice:old.tld", 1),
            ], [], false);
            const changes = await memberSync.write(txn);
            assert.equal(changes.size, 0);
            assert.equal(txn.members.get(alice).displayName, "@alice:new.tld");
            assert.equal(txn.members.get(alice).cygnusEpochHeight, 2);
        },
        "user epochs are ignored outside Cygnus rooms": async assert => {
            const writer = new MemberWriter(roomId);
            const txn = createStorage();
            const memberSync = writer.prepareMemberSync([
                createMemberEvent("join", alice, "Alice"),
                createEpochEvent(alice, "@ceo:bank.tld", 1),
            ], [], false);
            await memberSync.write(txn);
            assert.equal(txn.members.get(alice).displayName, "Alice");
            assert.equal(txn.members.get(alice).cygnusDisplayName, undefined);
        },
        "malformed user epoch heights are ignored": async assert => {
            for (const height of [-1, 1.5, NaN, "2", undefined]) {
                const writer = cygnusWriter();
                const txn = createStorage();
                const memberSync = writer.prepareMemberSync([
                    createMemberEvent("join", alice, "Alice"),
                    createEpochEvent(alice, "@ceo:bank.tld", height),
                ], [], false);
                await memberSync.write(txn);
                assert.equal(txn.members.get(alice).displayName, "Alice");
                assert.equal(txn.members.get(alice).cygnusDisplayName, undefined);
            }
        },
        "an epoch applies to later events in the same timeline": async assert => {
            const memberEvent = createMemberEvent("join", alice, "Alice");
            const epoch = createEpochEvent(alice, "@alice:new.tld", 1);
            const message = {
                type: "m.room.message", sender: alice, event_id: "$message",
                content: {body: "hi"},
            };
            const writer = cygnusWriter();
            const txn = createStorage();
            const memberSync = writer.prepareMemberSync([], [memberEvent, epoch, message], false);
            const member = await memberSync.lookupMemberAtEvent(alice, message, txn);
            assert.equal(member.displayName, "@alice:new.tld");
            assert.equal(member.cygnusEpochHeight, 1);
        },
        "an epoch later in the timeline does not rename an earlier event": async assert => {
            const memberEvent = createMemberEvent("join", alice, "Alice");
            const message = {
                type: "m.room.message", sender: alice, event_id: "$message",
                content: {body: "hi"},
            };
            const epoch = createEpochEvent(alice, "@alice:new.tld", 1);
            const writer = cygnusWriter();
            const txn = createStorage();
            const memberSync = writer.prepareMemberSync([memberEvent], [message, epoch], false);
            const member = await memberSync.lookupMemberAtEvent(alice, message, txn);
            assert.equal(member.displayName, "Alice");
            assert.equal(member.cygnusEpochHeight, undefined);
        },
    };
}

function createEpochEvent(principal, displayUserId, height, sender = principal, extra = {}) {
    return {
        type: "m.room.user_epoch",
        state_key: principal,
        sender,
        content: {display_user_id: displayUserId, height, ...extra},
        event_id: `$epoch${height}`,
    };
}
