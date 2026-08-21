# Session resume: what a restart loses, and a design for resume-without-repay

> Sprint 2 research note; feeds Sprint 3. Grounded in
> `packages/inference/src/conversation.ts`, `packages/inference/src/api.ts` and
> `apps/chat/workers/handlers/ai.mjs` as of this sprint. The README is explicit
> that picking up an old conversation opens a **new** session rather than
> reviving the old one, "whose key was ephemeral and is gone" — this note is
> about closing that gap for the crash/quick-restart case.

## What a session actually is (and what resume would need)

`Conversation` (conversation.ts:79) holds four pieces of live state, all
memory-only today:

1. **Session id** (`#sessionId`) — assigned by the contract, returned by the
   service (`openSession` → `sessionId`, or parsed from the `SessionCreated`
   event topic on the classic flow, conversation.ts:323-335). Cheap to persist.
2. **Session key** (`#sessionKey`) — a fresh symmetric key per session,
   generated locally (conversation.ts:191), sealed to the worker's and
   disputer's P-256 points, and never sent anywhere readable. The relay and the
   dispatcher carry ciphertext they cannot read _because_ this key is ephemeral.
   Persisting it is the whole design problem — see below.
3. **Relay socket** (`#socket`) — a WebSocket to
   `<relayUrl>?token=<token>`. The token comes from
   `GET /api/sessions/:id/token` (api.ts:348-354), which answers 202 until the
   session is confirmed on chain — i.e. token issue is a _read_ against an
   existing session id, not a new-session operation. Reconnecting a socket to
   a live session is protocol-supported.
4. **Job index** — which jobs belong to this conversation. Already persists:
   every answered turn is written to the transcript with its `jobId`
   (ai.mjs:766), so the per-turn index survives restart today. What does not
   survive is the in-flight wait (`#pending`) and the evidence behind the last
   answer (`#evidence`, memory-only — audit finding I2).

## What already persists

- **Transcripts** — an append-only Hypercore per identity,
  `history:<address>`, encrypted under a key derived from a wallet signature
  over a fixed string (main.mjs:491-527). Survives restart, unreadable while
  locked. Turns carry role, text, timestamp and `jobId`.
- **`localState`** — a `SealedStore` at `<chatDir>/local` (main.mjs:970),
  sealed under the unlocked wallet. Already holds spending limits, room-context
  flags and prompt templates. This is the natural home for resumable session
  state: same secrecy bar as the transcripts, same lock behaviour.
- **What does not persist**: the `Conversation` object itself
  (`session.conversation`, main.mjs:487), the session key, the socket, and the
  commitment/dispute evidence.

## What the protocol allows

- **Session reads.** `JobRegistry` exposes `getSession` — the audit
  (docs/build_audit_report.py, I4) already recommends reading it after
  `openSession` to compare `worker` and `encWorkerKey` against what was sealed.
  The same read is the resume gate: a session id that resolves to our worker
  with our sealed key is ours and verifiably untampered.
- **Inactivity timeout: 1800 s.** `AIConfig.sessionInactivityTimeout`
  (AIConfig.sol:114 per the audit; conversation.ts:489-491 and 712-717). A
  session idle for thirty minutes is expired on chain and submissions revert
  with `SessionNotActive`. This caps the value of resume: it is for crash
  recovery and quick restarts, not for coming back tomorrow.
- **Expiry is already handled mid-session.** `ask()` catches
  `SessionNotActive`, calls `#reopen`, and resubmits the same ciphertext
  (conversation.ts:484-497). Resume-at-boot is the same shape of operation,
  except the key must be _restored_ rather than regenerated — `#reopen` is the
  fallback when restore fails.
- **No repay path exists anyway.** `createSession` is payable and rejects any
  value, and on sortition deployments the service sends the transaction
  (ai.mjs:642-647) — so even the fallback costs nothing beyond the per-question
  fee. "Resume-without-repay" means skipping the draw and the open transaction,
  not avoiding a charge.

## Design: resume-without-repay

**Persist at session open** (in `ai.start`, after `ready`): a record in
`localState`, sealed under the wallet like templates —

```
resumable = {
  sessionId, model: { id, name }, worker,
  sessionKey: <hex>,          // the sensitive half; sealed store only
  conversationId,             // the transcript id, already known
  openedAt, lastActivityAt
}
```

Update `lastActivityAt` on each `ai.ask`. Clear the record on `ai.stop` and on
wallet lock (which ends the conversation today by design).

**Restore on unlock / `ai.start` with a matching conversation id:**

1. Read the record. If absent, locked, or `now - lastActivityAt` is anywhere
   near 1800 s, fall through to the existing fresh-session path — do not spend
   a draw finding out.
2. Read `getSession(sessionId)` on chain. Require: session active, `worker`
   matches the record, `encWorkerKey` matches what we would have sealed. Any
   mismatch → fresh session (this is the I4 check doing double duty).
3. Re-issue the relay token (`api.relayToken(sessionId)`) and reconnect the
   socket. Give `Conversation` a `resume({ sessionId, sessionKey, worker })`
   entry point that sets the four fields and connects, rather than reopening.
4. Resume commitment polling for any transcript turn with a `jobId` and no
   recorded commitment — the jobs were paid for whether we watched or not.
5. On any failure after step 1, `#reopen` semantics: fresh session, same
   conversation id, earlier turns folded by `withHistory` exactly as today's
   `req.continue` path does. The person asking never sees the difference beyond
   a faster ready.

**Boundaries to hold:**

- **Room sessions are never resumable.** `room.ask` publishes the session key
  into the room so members can verify the quotation (ai.mjs:917, 955-980), and
  the code is explicit that such a session "must never be reused for anything
  private". They close in a `finally` today, so simply never writing a resume
  record for them is sufficient.
- **The sealed store is the secrecy boundary.** The session key is what keeps
  the relay and dispatcher blind; writing it anywhere but `localState`
  (settings.json, the transcript core is fine too but localState is simpler)
  breaks the property the ephemeral key exists for.
- **Lock behaviour is a decision, not a detail.** Locking the wallet currently
  ends the conversation. Resume-on-unlock reopens one automatically; that is
  convenient and matches how transcripts behave, but it should be said in the
  UI, not discovered.
- **Evidence persistence is adjacent, not included.** Persisting
  ciphertext + signature per turn (audit I2) would make dispute survive a
  restart; it touches the transcript schema, which is append-only and needs a
  backward-compatible record shape. Track separately.

## Open questions for Sprint 3

- Does `getSession` return enough to detect a session the dispatcher created
  with a different sealed key (the I4 attack) — confirm the exact return shape
  against the deployed `JobRegistry` before writing the comparison.
- Relay behaviour on reconnect to a session with a job in flight: do late
  frames for the pre-restart job arrive on the new socket? `#activeJob` will
  be null after restart, so they would be dropped by design (conversation.ts:366-369)
  — acceptable, but the transcript should record the job as unanswered rather
  than leave it ambiguous.
