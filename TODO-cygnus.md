# Cygnus (MSC00FC) — what's still missing

Status: identity creation, key rotation, creating and joining rooms, signed
messages/redactions, signed leave/rejoin, Cygnus room indicators, and own-sender
recognition work against mocks (`src/matrix/cygnus/CygnusFlows.test.js`).
Nothing has run against a real homeserver yet; `../congruent` will be the first.

## Broken today in Cygnus rooms

- [x] **Own messages look like someone else's.** The sender of your events is
      your principal (`@<root>`), not your Matrix ID. About 57 comparisons in 9
      files under `src/matrix/room` and `src/domain/session/room` check
      `sender === ownUserId`, so own messages render as another user's, can't be
      edited or redacted from the menu, and may mark the room unread. Fix: give
      rooms an "own sender IDs" set (Matrix ID + principal) and compare against
      it. Implemented by recognizing both the Matrix ID and principal in room
      summaries, timelines, reactions, power checks, and verification handling.
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
- [ ] **Moving homeservers.** The API contract now covers `/principal/import`
      for moves and same-custodian advancement, but there's no UI to move a
      principal into a new custodian.
- [ ] **Recovery.** No UI to back up or restore the rotation key, and no warning
      before a cross-signing reset (which permanently breaks the principal — its
      master key is the cross-signing master key).
- [ ] **Errors.** Draft rejections ("refusing to sign the homeserver's draft:
      …") show as raw strings; make them readable and offer retry.

## Client and homeserver protocol work

- [ ] **Secret storage for the rotation key.** The key currently lives in
      IndexedDB and the localStorage backup. Hydrogen's SSSS implementation can
      read secrets but does not write them. Add SSSS writing and backup/restore.
      The proposal now specifies a 32-byte RFC 8032 seed in unpadded standard
      base64 and one active signer at a time; the client must re-read the secret
      before signing and write the next key before submitting. No
      Cygnus-specific homeserver endpoint is needed.
- [ ] **Revoked-device list.** Hydrogen always sends `[]` on import. Track
      device revocations locally and carry them across moves. `send_signed` on
      the homeserver must reject revoked devices through standard device
      management. The proposal now makes the certificate `device_id` the Matrix
      device ID and revocation permanent, so a new device must use a fresh ID.
- [ ] **Stale-epoch heuristic.** Implement the client check against the newest
      observed epochs. The proposal now makes the device floor mandatory and the
      epoch check SHOULD in both direct and assisted signing.
- [ ] **Device floors per room and device.** Hydrogen currently keys floors by
      room only; the proposal requires `(user, device_id, room)`. In Cygnus
      rooms, key the user component by principal.
- [ ] **Client-side API contract work.** Send `via` when drafting a join to a
      room the homeserver has no joined user in; send the full chain when moving
      to a new custodian; after import, draft and send a device-signed rebinding
      join in each room; and replace the "spec gap" comments in `CygnusRooms`
      and `CygnusIdentity` with references to the §9 contract.

## Spec decisions recorded; homeserver implementation pending

- [x] **Epoch events after create and join — specified.** The proposal now says
      the custodian emits/signs epoch events and the client signs the join, and
      defines the create/join ordering. Still implement the contract in Hydrogen
      and the homeserver.
- [x] **Starting a join from the client — specified.** The proposal now defines
      pre-join `event_draft` with `via`, `make_join`, epoch events, and
      `send_join`. Still implement the client and homeserver flow.
- [x] **Same-custodian rotation — specified.** `/principal/import` now covers
      moves and same-custodian chain advancement, including idempotent retry and
      room fan-out; the client sends device-signed rebinding joins. Still
      implement the contract in Hydrogen and the homeserver.
- [ ] **Cygnus homeserver implementation.** `../congruent` has no MSC00FC
      endpoints yet. Supporting the proposal requires more than adding routes:
      its event model assumes Matrix user IDs, while Cygnus needs principal
      senders, a different event ID hash, device-signature authorization, an
      extra state-resolution pass, and Cygnus join-handshake behavior. Implement
      the six client-server endpoints and these room-version changes, then
      validate them against Hydrogen.

## Upstream dependencies

- [ ] Vendored wasm is from cygnus-core `3d5d655`, which is local only. Push it
      and update `src/matrix/cygnus/wasm/README.md` if the hash changes.
- [ ] cygnus-core needs rezzy `ab3aed0` pushed and `cargo update -p rezzy`.
