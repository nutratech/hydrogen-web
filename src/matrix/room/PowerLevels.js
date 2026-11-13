/*
Copyright 2025 New Vector Ltd.
Copyright 2021 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

export const EVENT_TYPE = "m.room.power_levels";

// See https://spec.matrix.org/latest/client-server-api/#mroompower_levels
const STATE_DEFAULT_POWER_LEVEL = 50;

export class PowerLevels {
    constructor({powerLevelEvent, createEvent, ownUserId, membership}) {
        this._plEvent = powerLevelEvent;
        this._createEvent = createEvent;
        this._ownUserId = ownUserId;
        this._membership = membership;
    }

    canRedactFromSender(userId) {
        if (userId === this._ownUserId && this._membership === "join") {
            return true;
        } else {
            return this.canRedact;
        }
    }

    canSendType(eventType) {
        return this._myLevel >= this._getEventTypeLevel(eventType);
    }

    get canRedact() {
        return this._myLevel >= this._getActionLevel("redact");
    }

    get canInvite() {
        return this._myLevel >= this._getActionLevel("invite");
    }

    get canKick() {
        return this._myLevel >= this._getActionLevel("kick");
    }

    get canBan() {
        return this._myLevel >= this._getActionLevel("ban");
    }

    /** Kick needs a higher level and only makes sense while the member is present and not banned. */
    canKickUser(userId, membership) {
        return this.canKick && membership !== "leave" && membership !== "ban" &&
            this._hasHigherLevelThan(userId);
    }

    /** Ban needs a higher level, but is also allowed against someone who already left. */
    canBanUser(userId, membership) {
        return this.canBan && membership !== "ban" && this._hasHigherLevelThan(userId);
    }

    _hasHigherLevelThan(userId) {
        return this.getUserLevel(userId) < this._myLevel;
    }

    get _myLevel() {
        if (this._membership !== "join") {
            return Number.MIN_SAFE_INTEGER;
        }
        return this.getUserLevel(this._ownUserId);
    }

    getUserLevel(userId) {
        if (this._plEvent) {
            let userLevel = this._plEvent.content?.users?.[userId];
            if (typeof userLevel !== "number") {
                userLevel = this._plEvent.content?.users_default;
            }
            if (typeof userLevel === "number") {
                return userLevel;
            }
        } else if (this._createEvent) {
            const isLegacyCreator = userId === this._createEvent.content?.creator;
            const isCygnusCreator = !!this._createEvent.content?.creator_links &&
                userId === this._createEvent.sender;
            if (isLegacyCreator || isCygnusCreator) {
                return 100;
            }
        }
        return 0;
    }

    /** @param {string} action either "invite", "kick", "ban" or "redact". */
    _getActionLevel(action) {
        const level = this._plEvent?.content?.[action];
        if (typeof level === "number") {
            return level;
        } else {
            return STATE_DEFAULT_POWER_LEVEL;
        }
    }

    _getEventTypeLevel(eventType) {
        const level = this._plEvent?.content?.events?.[eventType];
        if (typeof level === "number") {
            return level;
        } else {
            const level = this._plEvent?.content?.events_default;
            if (typeof level === "number") {
                return level;
            } else {
                return 0;
            }
        }
    }
}

export function tests() {
    const alice = "@alice:hs.tld";
    const bob = "@bob:hs.tld";
    const charly = "@charly:hs.tld";
    const createEvent = {content: {creator: alice}};
    const redactPowerLevelEvent = {content: {
        redact: 50,
        users: {
            [alice]: 50
        },
        users_default: 0
    }};
    const eventsPowerLevelEvent = {content: {
        events_default: 5,
        events: {
            "m.room.message": 45,
            "m.room.topic": 50,
        },
        users: {
            [alice]: 50,
            [bob]: 10
        },
        users_default: 0
    }};

    return {
        "redact somebody else event with power level event": assert => {
            const pl1 = new PowerLevels({powerLevelEvent: redactPowerLevelEvent, ownUserId: alice, membership: "join"});
            assert.equal(pl1.canRedact, true);
            const pl2 = new PowerLevels({powerLevelEvent: redactPowerLevelEvent, ownUserId: bob, membership: "join"});
            assert.equal(pl2.canRedact, false);
        },
        "redact somebody else event with create event": assert => {
            const pl1 = new PowerLevels({createEvent, ownUserId: alice, membership: "join"});
            assert.equal(pl1.canRedact, true);
            const pl2 = new PowerLevels({createEvent, ownUserId: bob, membership: "join"});
            assert.equal(pl2.canRedact, false);
        },
        "the Cygnus create sender is the room creator": assert => {
            const cygnusCreateEvent = {
                sender: alice,
                content: {creator_links: {user: ["chain"]}},
            };
            const creator = new PowerLevels({
                createEvent: cygnusCreateEvent, ownUserId: alice, membership: "join",
            });
            assert.equal(creator.getUserLevel(alice), 100);
            assert.equal(creator.canRedact, true);
            assert.equal(creator.canKickUser(bob, "join"), true);
            assert.equal(creator.canBanUser(bob, "join"), true);
            const member = new PowerLevels({
                createEvent: cygnusCreateEvent, ownUserId: bob, membership: "join",
            });
            assert.equal(member.getUserLevel(bob), 0);
            assert.equal(member.canRedact, false);
            assert.equal(member.canKickUser(alice, "join"), false);
        },
        "redact own event": assert => {
            const pl = new PowerLevels({ownUserId: alice, membership: "join"});
            assert.equal(pl.canRedactFromSender(alice), true);
            assert.equal(pl.canRedactFromSender(bob), false);
        },
        "can send event without power levels": assert => {
            const pl = new PowerLevels({createEvent, ownUserId: charly, membership: "join"});
            assert.equal(pl.canSendType("m.room.message"), true);
        },
        "can't send any event below events_default": assert => {
            const pl = new PowerLevels({powerLevelEvent: eventsPowerLevelEvent, ownUserId: charly, membership: "join"});
            assert.equal(pl.canSendType("m.foo"), false);
        },
        "can't send event below events[type]": assert => {
            const pl = new PowerLevels({powerLevelEvent: eventsPowerLevelEvent, ownUserId: bob, membership: "join"});
            assert.equal(pl.canSendType("m.foo"), true);
            assert.equal(pl.canSendType("m.room.message"), false);
        },
        "can send event above or at events[type]": assert => {
            const pl = new PowerLevels({powerLevelEvent: eventsPowerLevelEvent, ownUserId: alice, membership: "join"});
            assert.equal(pl.canSendType("m.room.message"), true);
            assert.equal(pl.canSendType("m.room.topic"), true);
        },
        "can't redact or send in non-joined room'": assert => {
            const pl = new PowerLevels({createEvent, ownUserId: alice, membership: "leave"});
            assert.equal(pl.canRedact, false);
            assert.equal(pl.canRedactFromSender(alice), false);
            assert.equal(pl.canSendType("m.room.message"), false);
        },
        "kick and ban require a strictly higher level": assert => {
            const event = {content: {users: {[alice]: 50, [bob]: 25, [charly]: 50}}};
            const pl = new PowerLevels({powerLevelEvent: event, ownUserId: alice, membership: "join"});
            assert.equal(pl.canKickUser(bob, "join"), true);
            assert.equal(pl.canKickUser(charly, "join"), false);
            assert.equal(pl.canBanUser(bob, "join"), true);
            assert.equal(pl.canBanUser(charly, "join"), false);
            assert.equal(pl.canBanUser(alice, "join"), false);
            assert.equal(pl.canKickUser(bob, "leave"), false);
            assert.equal(pl.canKickUser(bob, "ban"), false);
            assert.equal(pl.canBanUser(bob, "ban"), false);
            // a preemptive ban is allowed against someone who already left
            assert.equal(pl.canBanUser(bob, "leave"), true);
        },
    }
}
