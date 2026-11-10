# Cygnus workspace: one session, two account connections

## Goal

Moving a Cygnus principal to another homeserver must not create a second
session for the user. They keep one workspace in the session picker, and their
ordinary rooms on the old account keep working. One access token cannot sync
two homeservers, so the workspace holds two Matrix account connections:

- **source**: the account the workspace started with, on the old homeserver.
- **destination**: an account on the principal's new homeserver.

The destination never appears in the session picker on its own.

## Architecture

A `Workspace` sits above two ordinary sessions. `Session`, `Sync` and
`RequestScheduler` stay single-homeserver; nothing below the workspace learns
that there are two servers.

- Each `AccountConnection` is an ordinary Hydrogen client: its own
  `sessionInfo`, `HomeServerApi`, `Reconnector`, `Sync`, access token, Olm
  device, cross-signing state and IndexedDB storage. Storage is already per
  session (`storageFactory.create(sessionId)`), so the two never share a store,
  and the same room ID can exist under both accounts without colliding.
- The destination's `sessionInfo` records the workspace it belongs to
  (`workspaceId`); the picker lists only sessions without one.
- The workspace owns what the user sees as one session: the merged room list,
  navigation, notifications, unread counts and sync status.

### Room ownership

The workspace persists `roomId → connectionId`. Ownership is never inferred
from the room ID or a server name: room version 12 IDs name no server, and both
accounts can be in the same room.

| Room                                | Owner       | Changes when                             |
| ----------------------------------- | ----------- | ---------------------------------------- |
| Rooms that existed before the move  | source      | never, except Cygnus rooms (next row)    |
| Cygnus rooms                        | source      | `send_signed` confirms the signed rebind |
| Rooms created after the destination | destination | never                                    |
| A room both accounts are in         | source      | never; the destination's copy is hidden  |

Exactly one connection manages a room at a time. The non-owning connection may
still sync it, but the workspace hides that copy: its timeline, unread state
and notifications. Read state stays per account until a room changes owner.

### Routing

Room handles come from the workspace and are bound to the owning connection,
so sends, receipts, typing, redactions, invites, kicks, media, keys and room
settings all go to the owner. There are no `if (legacy)` checks in UI code.
A `RoomRouter` (or the room handle itself) is the one place that knows owners.

### Failure and logout

- **Source unreachable or its token expired:** its rooms show from cache in a
  **Legacy** area, read-only. This reflects the connection state; it is not
  what makes legacy rooms work. "Down" means one of:
    - the token is rejected (`M_UNKNOWN_TOKEN`, soft logout): offer
      re-authentication, keeping the room cache;
    - the server is unreachable (DNS, TLS or connection failure, 5xx): the
      reconnector keeps retrying in the background, as it does today.
- **Destination unreachable:** its rooms are read-only from cache; sends queue.
- **Logout:** "Remove workspace" logs out both connections. "Retire old
  account" logs out only the source, after its rooms are moved or given up.
  Neither deletes an account silently.

## Cygnus on top of the workspace

### Same device ID on both accounts

The destination logs in with `device_id` set to the source session's device
ID; Matrix `/login` and `/register` accept one. Each account still has its own
Olm keys under that ID. The Cygnus device key and certificate are not Olm keys:
the certificate binds a device ID to Hydrogen's own Cygnus device key (§5.2.1).
With the same ID the certificate stays valid on the destination, so:

- the device needs no re-certification;
- device floors carry over, since they are keyed by (principal, device, room);
- the device is **not** revoked on import. Revocation is permanent per device
  ID (proposal `48402eb4c`), so revoking it would lock this device out of the
  new custodian for good.

Servers may ignore the requested ID. The login checks
`response.device_id === identity.deviceId` and stops before anything is signed
if it differs.

### Cross-signing on the destination

§5.2.1 binds the principal to the account's cross-signing master key, so the
destination account publishes the same master, self-signing and user-signing
keys (`keys/device_signing/upload`, UIA with the password just entered),
taken from the source's secret storage. `keys/query` must return them before
the move link is signed.

### The move

The source signs the move link: the current rotation key never leaves it, and
the destination receives only the next key and the signed link. Once signed,
the key is spent, so the move is retry-only:

1. The destination connection is logged in (same device ID) and publishes the
   cross-signing keys.
2. The source signs the move link and persists the link and the next rotation
   key. From now on it is locked for signing. It cannot cancel back to normal
   signing, because its rotation key is spent.
3. The workspace copies the Cygnus identity record (same device key and
   certificate, the next rotation key, revoked IDs) into the destination's
   storage, and the destination backs the next key up to its own secret
   storage. Both connections are in the same browser, so nothing is
   transported.
4. The destination imports the full chain, with the existing revoked list and
   without this device ID. On failure, retry the same import.
5. Once the import and backup are confirmed, the source is retired: its
   rotation key is deleted locally and from its secret storage.
6. The destination sends a signed rebinding join in each Cygnus room, `via` the
   old display ID's server. Each confirmed rebind moves that room's ownership
   to the destination, and the room's local history moves with it (below).

### Keeping history when a room changes owner

The room ID is stable, so the user should not lose anything when ownership
moves. On transfer the workspace copies the room's records from the source's
storage into the destination's: summary, timeline fragments and events, room
state, members, read receipts and unread counts. Only pagination restarts: the
copied fragments keep their events but drop the source's pagination tokens and
end in a gap, so the next backfill asks the destination server. The source's
copy is then hidden, and deleted when the source is retired.

The encrypted move bundle (`19d50f93`) remains for moving to a different
device, where the two connections are not in the same browser.

## Sequencing

Do not combine the workspace refactor with the Cygnus move in one change: the
move changes a room's owner, so ownership and routing must exist first. One
agent owns the whole refactor on `feat/cygnus-workspace`, and it merges only
after the Node 18 suite and both lints pass.

1. Login and registration with a requested device ID, checking the returned
   one. Isolated.
2. Cross-signing upload on the destination account. Isolated, and a hard
   prerequisite for the move.
3. `Workspace`, `AccountConnection` and persistent room ownership, with the
   source connection only. Existing rooms are assigned to the source. No
   behaviour change.
4. Route every room operation through its owner, with tests for send,
   receipt, invite, leave and media.
5. The second connection: hidden `sessionInfo`, a full sync with its own E2EE
   (so new ordinary rooms can be encrypted), merged room list, notifications
   and sync status.
6. The Cygnus move: source signs and locks, retry the import, rebind, then
   transfer ownership with the room's history.
7. The move screen, the Legacy area and the two logout actions.

## Open questions

- Which server takes receipts and typing in Cygnus rooms; the proposal is
  silent. This design sends them to the room's owner.
- The proposal's handoff text (`384b10893`, `42bdc26f5`) should say that when
  the destination login reuses the device ID, the certificate stays valid and
  the device is not revoked.
- A room both accounts are in stays owned by the source. Whether the user can
  choose to switch it is a later UI decision.
