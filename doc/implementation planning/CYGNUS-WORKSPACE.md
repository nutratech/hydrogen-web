# Cygnus workspace: one session, two account connections

## Goal

Moving a Cygnus principal to another homeserver must not create a second
Hydrogen session. The user keeps one workspace in the session picker. Under it,
Hydrogen holds two Matrix account connections:

- **home**: the account the session was created with, on the old homeserver.
  It keeps everything it has today: ordinary rooms, Olm/Megolm, account data,
  secret storage, to-device messages and device lists.
- **custodian**: an account on the principal's new homeserver, logged in with
  the **same device ID** as the home connection.

One access token cannot sync two homeservers, so the two connections are real,
but the second one never appears as a session of its own.

## Why the same device ID

Matrix `/login` and `/register` accept a `device_id`. Reusing the home device
ID on the custodian keeps the Cygnus device certificate valid: the certificate
binds a device ID to this session's Cygnus device key (§5.2.1), and both stay
the same. That means:

- no re-certification and no key transport: the rotation key, device seed and
  cross-signing keys never leave this session;
- device floors carry over, since they are keyed by (principal, device, room);
- the device is **not** revoked on import. Revocation is permanent per device
  ID (proposal `48402eb4c`), so revoking it would lock this device out of the
  new custodian for good.

Servers may ignore a requested `device_id`. The login helper checks
`response.device_id === identity.deviceId` and aborts before anything is
signed if it differs.

## Room affinity

Every room belongs to exactly one connection, recorded in its summary
(`connection: "home" | "custodian"`, default `"home"`).

| Room                          | Connection                               | When it changes                                |
| ----------------------------- | ---------------------------------------- | ---------------------------------------------- |
| Existing ordinary rooms       | home                                     | never                                          |
| Cygnus rooms before the move  | home                                     | when `send_signed` confirms its rebinding join |
| Cygnus rooms after the rebind | custodian                                | never (a later move starts the cycle again)    |
| Rooms created after the move  | custodian                                | never                                          |
| Invites                       | the connection whose sync delivered them |

The switch happens only after the signed rebind is confirmed, so the two
connections never manage the same room at once. When a room switches:

- the home sync ignores it from then on, including any `leave` or archive the
  old server reports, so a moved room is never archived locally;
- its timeline gets a new live fragment (a gap), because pagination tokens are
  issued per server and the old ones mean nothing to the custodian;
- its pending sends are retried through the custodian.

## Workspace coordinator

A `Workspace` owns both connections and is what the UI sees as the session:

- one `HomeServerApi`, `Reconnector` and sync loop per connection;
- a merged room list: one observable map over both connections, each room
  tagged with its affinity;
- a merged sync status: the UI shows connected only when both are, and names
  the connection that is offline otherwise;
- routing: every room-scoped request goes to the room's connection (table
  below). Account-scoped requests go to home in v1.

The custodian sync is a thin loop, not a second `Sync`: a second `Sync` would
fight the home one over to-device messages, device lists and the session's
sync token. It keeps its own token (`cygnus.custodian.syncToken`), filters to
custodian rooms, turns off presence and account data, and drives the existing
`room.prepareSync`, `writeSync` and `afterSync` for those rooms.

### Routing

| Request                                       | Goes to                                                 |
| --------------------------------------------- | ------------------------------------------------------- |
| `event_draft`, `send_signed`, plain sends     | room's connection                                       |
| `/messages`, `/context` (backfill)            | room's connection                                       |
| `/members`, `/state` (member loading)         | room's connection                                       |
| join, leave, invite, kick, ban, forget        | room's connection                                       |
| read receipts, typing                         | room's connection                                       |
| media upload                                  | room's connection                                       |
| media download                                | home (any server can serve any `mxc://` via federation) |
| account data, secret storage, to-device, keys | home (v1)                                               |

## The in-place move

Run from the existing session; the user sees one password prompt.

1. **Log in to the new homeserver** with the current device ID (password login
   or registration; SSO redirects would leave the running session, so they
   come later). Check the returned device ID. Persist the custodian
   credentials before going further, so every later step can resume.
2. **Publish the same cross-signing keys** on the new account with
   `keys/device_signing/upload` (UIA with the password just entered), using the
   master, self-signing and user-signing keys from home secret storage. Gate
   the next step on `keys/query` returning them: §5.2.1 binds the principal to
   that master key.
3. **Sign the move link** with this session's rotation key and back the next
   key up locally and to home secret storage (it is replicated to the
   custodian's secret storage later).
4. **Import** the full chain at the custodian, with the existing revoked list
   and without this device ID. Retry with the same links on failure.
5. **Rebind each Cygnus room** with a signed join through the custodian, `via`
   the old display ID's server. Each confirmed rebind flips that room's
   affinity.
6. **Start the custodian sync** and keep it running alongside home.

## Failure modes

- **Home homeserver unreachable:** its rooms stay visible from the local cache
  in a **Legacy** section, read-only, until it reconnects. This is a fallback,
  not the normal state.
- **Custodian unreachable:** custodian rooms are read-only from cache; sends
  queue as usual.
- **Logout** logs out both access tokens.

## Out of scope for v1

- **E2EE on the custodian connection.** The custodian account has no Olm
  device keys yet, so custodian rooms (moved Cygnus rooms and new rooms) are
  unencrypted. Cygnus rooms are unencrypted today anyway; new ordinary rooms
  created after the move would be a regression and need Olm on the custodian
  connection.
- **Custodian secret storage.** The rotation key stays in home secret storage
  plus the local copy until the custodian account has its own.
- **A home account that has itself moved.** One move per workspace in v1.

## Phases

Each phase is testable with mocks before the next.

1. Login helper with `device_id` and the device-ID check.
2. Cross-signing upload on the custodian account, gated by `keys/query`.
3. In-place move service: persisted custodian credentials, sign, import
   (current device not revoked), rebind, affinity flip. Restores the
   single-session path of `moveToCustodian` (`ea5dfec8`).
4. Per-room routing of `hsApi` through the room's connection.
5. Custodian sync loop, home-sync skipping of moved rooms, fragment gap on
   switch.
6. Workspace coordinator: merged room list and sync status, Legacy section,
   dual logout.
7. Move screen.

## Open questions

- Receipts and typing in Cygnus rooms: the proposal does not say which server
  takes them; this design sends them to the room's connection.
- The proposal's handoff text (`384b10893`, `42bdc26f5`) should add that when
  the destination login reuses the device ID, the certificate stays valid and
  the device is not revoked.
