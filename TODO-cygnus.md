# Cygnus (MSC00FC) — what's still missing

Status: identity creation, key rotation, creating and joining rooms, and signed
messages/redactions work against mocks
(`src/matrix/cygnus/CygnusFlows.test.js`). Nothing has run against a real
homeserver yet; `../congruent` will be the first.

## Broken today in Cygnus rooms

- [ ] **Own messages look like someone else's.** The sender of your events is
      your principal (`@<root>`), not your Matrix ID. About 57 comparisons in 9
      files under `src/matrix/room` and `src/domain/session/room` check
      `sender === ownUserId`, so own messages render as another user's, can't be
      edited or redacted from the menu, and may mark the room unread. Fix: give
      rooms an "own sender IDs" set (Matrix ID + principal) and compare against
      it.
- [x] **Leave uses the plain `/leave`** (`Room.js` `leave`). It must be a
      device-signed `m.room.member` `leave` through `cygnus.sendRoomEvent`-style
      state sending.
- [ ] **Accepting or rejecting an invite uses `/join` and `/leave`**
      (`Invite.js`). The invite view needs to know the room is Cygnus (room
      version from invite state) and sign the membership.
- [x] **Rejoining an archived room uses `/join`** (`ArchivedRoom.js`).
- [x] **Group calls send state with `hsApi.sendState`** (`GroupCall.ts`). Hide
      calls in Cygnus rooms or route them through signed sends.

## Missing UI

- [ ] **Room membership actions.** Invite, kick and ban need the target's
      principal: `CygnusService.lookupPrincipal` exists but nothing calls it.
      Hydrogen has no invite UI at all yet; add one that resolves a Matrix ID to
      a principal for Cygnus rooms.
- [ ] **Signed state events in general.** Only create/join/join_rules/name/topic
      are sent (all from `CygnusRooms`). Add a `sendStateEvent` path (via
      `CygnusEventSigner`) for renaming, changing the topic, power levels and
      join rules after creation.
- [ ] **Avatar, alias and encryption** for Cygnus rooms. Create Room hides
      encryption and ignores avatar/alias when the Cygnus box is ticked.
- [ ] **Join by alias.** Join needs a `!roomid`; aliases aren't resolved for
      Cygnus.
- [ ] **Display names.** Principals show as raw `@<43 chars>`. Read
      `display_user_id` from each member's `m.room.user_epoch` and show that,
      with the principal on hover or in the member panel.
- [x] **Room indicator.** Nothing in the room list, header or room details shows
      that a room is Cygnus, or its room version.
- [ ] **Verification status.** `CygnusVerifier` can check event IDs, device and
      custodian signatures, but timeline items show no trust indicator and
      incoming events aren't verified.
- [ ] **Member panel.** Show each member's principal, custodian and chain
      height.
- [ ] **Moving homeservers.** `/principal/import` is used only for rotation;
      there's no UI to import a principal into a new custodian.
- [ ] **Recovery.** No UI to back up or restore the rotation key, and no warning
      before a cross-signing reset (which permanently breaks the principal — its
      master key is the cross-signing master key).
- [ ] **Errors.** Draft rejections ("refusing to sign the homeserver's draft:
      …") show as raw strings; make them readable and offer retry.

## Protocol pieces not implemented

- [ ] Rotation key in secret storage (`m.principal.rotation_key`). It only lives
      in IndexedDB and the localStorage backup on this device; Hydrogen can't
      write SSSS.
- [ ] Revoked-device list is always `[]`.
- [ ] Stale-epoch heuristic.
- [ ] Device floors are keyed per room only, not per room + device.

## Spec gaps to settle with congruent

- [ ] Who sends the `m.room.user_epoch` / `m.room.server_epoch` events after
      create and join? Hydrogen assumes the custodian does.
- [ ] How does a client join a room it isn't in yet? Hydrogen assumes
      `event_draft` works for that room and triggers make_join/send_join.
- [ ] Same-custodian rotation: Hydrogen uses `/principal/import`, which the spec
      only defines for moving servers.

## Upstream dependencies

- [ ] Vendored wasm is from cygnus-core `3d5d655`, which is local only. Push it
      and update `src/matrix/cygnus/wasm/README.md` if the hash changes.
- [ ] cygnus-core needs rezzy `ab3aed0` pushed and `cargo update -p rezzy`.
