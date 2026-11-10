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
- [x] **Accepting or rejecting an invite uses `/join` and `/leave`**
      (`Invite.js`). The invite view needs to know the room is Cygnus (room
      version from invite state), derive resident servers from its epoch events
      for signed join drafts, and sign the membership. Failed requests reset the
      loading state so the action can be retried.
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
      for moves and same-custodian advancement. Client plumbing sends the full
      chain, persists/retries the move, and rebinds each room through the old
      display ID's server; the local device floor remains keyed to the same
      principal/device/room. The service refuses a destination with a different
      device ID because it cannot yet certify that device or switch the whole
      Hydrogen session (sync and regular Matrix APIs still use the source
      session). Add a two-session handoff, destination-device certification,
      then the UI.
- [ ] **Recovery.** No UI to back up or restore the rotation key, and no warning
      before a cross-signing reset (which permanently breaks the principal — its
      master key is the cross-signing master key).
- [ ] **Errors.** Draft rejections ("refusing to sign the homeserver's draft:
      …") show as raw strings; make them readable and offer retry.

## Client and homeserver protocol work

- [x] **Secret storage for the rotation key.** The 32-byte seed is now written
      through Matrix secret storage, and clients re-read it before signing and
      write the next key before submitting a rotation or move. The identity
      record remains in IndexedDB and its localStorage backup. A user-facing
      backup/restore flow is still missing (see Recovery above). The proposal
      now specifies a 32-byte RFC 8032 seed in unpadded standard base64 and one
      active signer at a time; the client must re-read the secret before signing
      and write the next key before submitting. No Cygnus-specific homeserver
      endpoint is needed.
- [ ] **Revoked-device list.** Device IDs are persisted and included in rotation
      and move imports; `CygnusService.revokeDevice` records another device and
      publishes the revocation with a chain advancement. Hydrogen has no
      device-management UI to choose and confirm a device to revoke.
      `send_signed` on the homeserver must reject revoked devices. The proposal
      makes revocation permanent, so a replacement device must use a fresh ID.
- [x] **Stale-epoch heuristic.** Before signing, compare the draft's
      `auth_events` with the newest observed user and custodian epochs; refuse
      when it omits either epoch or the user's epoch height differs from the
      local chain. The proposal makes this a SHOULD in both signing modes.
- [x] **Device floors per room and device.** Floors are keyed by principal,
      device ID, and room ID, as required by the proposal.
- [x] **Client-side API contract plumbing.** Join drafts now pass `via`; the
      move service sends the full chain and resumes device-signed rebinding
      joins after import; `CygnusRooms` and `CygnusIdentity` refer to the §9
      contract. The user-facing move flow is still missing above.

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
