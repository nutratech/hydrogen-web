# Cygnus (MSC00FC) — what's still missing

Status: identity creation, key rotation, creating and joining rooms, signed
messages/redactions, signed leave/rejoin, Cygnus room indicators, and own-sender
recognition work against mocks (`src/matrix/cygnus/CygnusFlows.test.js`).
Nothing has run against a real homeserver yet; `../congruent` will be the first.

## Broken today in Cygnus rooms

- [x] **Own messages look like someone else's.** The sender of your events is
      your principal (`@<root>`), not your Matrix ID. `BaseRoom.ownUserIds`
      returns the Matrix ID plus the principal for Cygnus rooms, and room
      summaries, timelines (resolved at lookup, so a late-created identity is
      seen), reactions, power levels (reloaded when the identity changes),
      message tiles and verification handling compare against that set. The
      remaining direct `sender ===` comparisons are either set-aware
      (`BaseMessageTile`, `VerificationTile`) or unrelated to own-sender
      recognition (`RoomMemberTile`, tile grouping).
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
- [ ] **Invites that arrive before the identity loads.** `_getMyInvite` only
      knows the Matrix ID until `CygnusService.identity` is set, so a Cygnus
      invite in that window is not stored. Defer invite processing until the
      stored identity has loaded, or retry it once the principal is known
      (`pr.2.md`, `Invite.js:287`).

## Missing UI

- [x] **Room membership actions.** The existing invite panel now resolves a
      Matrix ID to a principal for Cygnus rooms, and member details can kick or
      ban a principal through device-signed `m.room.member` events
      (`lookupPrincipal` → `sendMembershipEvent`). The plain `/invite` and
      `/state` paths are no longer used for Cygnus rooms.
- [x] **Signed state events in general.** `Room.sendStateEvent` routes through
      `CygnusService.sendStateEvent` (and therefore `CygnusEventSigner`) for
      Cygnus rooms, with helpers for name, topic, join rules and power levels.
      Callers still need to supply the complete content for power levels and
      join rules.
- [ ] **Avatar, alias and encryption** for Cygnus rooms. Create Room hides
      encryption and ignores avatar/alias when the Cygnus box is ticked.
- [ ] **Join by alias.** Join needs a `!roomid`; aliases aren't resolved for
      Cygnus.
- [x] **Display names.** Principals show as raw `@<43 chars>`. `MemberWriter`
      now applies each member's `m.room.user_epoch` `display_user_id` to the
      stored member, including epochs that arrive without a member event and
      newer epochs replacing older ones. The principal remains the member's
      `userId`, so the member panel can still show it.
- [x] **Room indicator.** Nothing in the room list, header or room details shows
      that a room is Cygnus, or its room version.
- [ ] **Verification status.** `CygnusVerifier` can check event IDs, device and
      custodian signatures, but timeline items show no trust indicator and
      incoming events aren't verified.
- [ ] **Member panel.** Show each member's principal, custodian and chain
      height.
- [ ] **Moving homeservers.** The service signs and encrypts the handoff on the
      source, retires it before releasing the bundle, imports and certifies the
      destination device, then sends signed rebinding joins. The user-facing
      move screen is still missing. See "Move handoff design".
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

**Source session (`prepareMoveHandoff`)**

1. Sign the move link locally with the current rotation key. Retire the source
   device before releasing anything: remove its rotation and device signing keys
   so it cannot sign again. Encrypt and retain the bundle locally until the
   destination confirms import. It includes:
    - the verified chain from genesis plus the signed move link;
    - the next rotation key, never the spent current key;
    - the cross-signing master, self-signing and user-signing private keys;
    - revoked device IDs, plus this session's Cygnus device ID;
    - the joined Cygnus room IDs, and the old display ID's server for `via`.
2. If the app stops after source retirement, it can release the same encrypted
   bundle again.

**Destination session (`importMoveHandoff`)**

1. Decrypt and validate the source-signed chain, target account, master key, and
   next rotation key against the signed move state and this account's published
   cross-signing keys.
2. `POST /principal/import` with the full chain and revoked-device list,
   including the source device. Retry by importing the same encrypted bundle
   after a lost response.
3. Certify this session's device under the carried master and self-signing keys.
   Persist the certificate and next rotation key locally and in destination
   secret storage before signing room events.
4. Acknowledge import so the source can delete its retained encrypted bundle.
5. Send a device-signed rebinding join in each room with `via` set to the old
   display ID's server. The new device starts without a room floor; its first
   confirmed event establishes it.

**Open questions**

- **Cross-signing on the new account.** §5.2.1 binds the principal to the
  account's cross-signing master key, and `POST /principal` checks it. The
  destination account must publish the same master key as its cross-signing
  master key. `importMoveHandoff` publishes all three carried keys before
  validating them, through either a `publishCrossSigningKeys` callback or a
  `requestPassword` prompt for UIA; the move screen still has to supply one. The
  proposal should say whether `/principal/import` checks this too.
- **Source session after the move.** It stays logged in on the old homeserver,
  retired. Offer to log it out.
- **Move screen.** The service encrypts and retains the bundle; the UI still
  needs to collect a passphrase before source preparation, transfer the
  ciphertext, and offer recovery/retry. Once the source signs the move link, the
  flow must resume that same link rather than cancel it.

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
      when it cites an older observed epoch event. Unseen or omitted epochs are
      accepted because the homeserver may be ahead of `/sync`. The proposal
      makes this a SHOULD in both signing modes.
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
      validate them against Hydrogen. Nothing in `congruent` references Cygnus
      today: first add the `cygnus-core` dependency (`state-res` feature), a
      persistent account→principal/chain store plus the custodian signing key
      and revoked-device list, then the routes (only advertise `tk.nutra.cygnus`
      once all six are present), and finally register the room version and its
      PDU/auth/state-resolution/join changes. This is homeserver work, not a
      small client follow-up.

## Upstream dependencies

- [ ] Vendored wasm is from cygnus-core `3d5d655`, which is local only. Push it
      and update `src/matrix/cygnus/wasm/README.md` if the hash changes.
- [ ] cygnus-core needs rezzy `ab3aed0` pushed and `cargo update -p rezzy`.
