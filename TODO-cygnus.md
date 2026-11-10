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
- [ ] **Moving homeservers.** The two-session service handoff now carries the
      source identity explicitly, imports the full chain and old device
      revocation from the destination session, certifies the destination
      device, backs up the key, retires the source signer, and retries signed
      rebinding joins through the old display ID's server. The user-facing
      encrypted handoff and move screen are still missing. See "Move handoff
      design".
- [ ] **Recovery.** No UI to back up or restore the rotation key, and no warning
      before a cross-signing reset (which permanently breaks the principal — its
      master key is the cross-signing master key).
- [ ] **Errors.** Draft rejections ("refusing to sign the homeserver's draft:
      …") show as raw strings; make them readable and offer retry.

## Move handoff design

A move runs across two Hydrogen sessions: the **source** (logged in on the old
homeserver, holding the identity) and the **destination** (logged in on the new
homeserver, with its own Matrix device ID). Proposal §9 "Device handoff on a
move" (proposals `384b10893`) is the normative text; this is how Hydrogen
implements it.

**Why two sessions.** The destination device has a different Matrix device ID,
and §5.2.1 binds a certificate to one device ID. Signing through the new
custodian with the source's certificate would be refused, and sync and the
regular Matrix APIs must follow the move anyway. Secret storage lives on the old
homeserver, so the destination cannot read it: everything it needs is carried
explicitly.

**Source session (`exportMoveBundle`)**

1. Export a versioned bundle to the authenticated destination session. It
   includes:
    - the verified chain from genesis and any already-pending move link/state;
    - the current rotation key and any pending move/rebind state;
    - the cross-signing master and self-signing private keys;
    - revoked device IDs, plus this session's Cygnus device ID;
    - the joined Cygnus room IDs, and the old display ID's server for `via`.
2. Lock signing on the source while the handoff is in progress. Keep its key
   material until destination import and backup succeed so a failed transfer
   can be exported again.

**Destination session (`moveFrom`)**

1. Validate the chain, keys and pending state from the bundle against this
   account's published cross-signing keys.
2. Sign the move link with the carried rotation key (or resume an existing
   pending move). Back up its next key to destination secret storage before
   submitting the link.
3. `POST /principal/import` with the full chain and `revoked_device_ids`,
   including the source device. Retry with the same links on failure; the call
   is idempotent.
4. Adopt the returned chain, then certify this session's device under the same
   master and self-signing keys. Persist the new certificate and key locally
   and in destination secret storage before signing room events.
5. Retire the source signer and remove its rotation key from its local record
   and old secret storage.
6. Send a device-signed rebinding join in each room with `via` set to the old
   display ID's server. The destination floor is established by its first
   confirmed event; floors are keyed by principal, device and room.

**Open questions**

- **Cross-signing on the new account.** §5.2.1 binds the principal to the
  account's cross-signing master key, and `POST /principal` checks it. The
  destination account must publish the same master key as its cross-signing
  master key; Hydrogen cannot upload cross-signing keys yet. The proposal
  should say whether `/principal/import` checks this too.
- **Source session after the move.** It stays logged in on the old homeserver,
  retired. Offer to log it out.
- **Transport security.** The current service API passes the bundle in memory
  between sessions. A user-facing flow must encrypt it for transport and avoid
  logging or persisting it in plaintext.

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
