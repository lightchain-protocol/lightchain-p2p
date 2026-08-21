# Production key ceremony — runbook

**Sprint 4, item R-1.** This is the one release task only the user can perform:
minting the real production identity for `apps/chat` (LightchainChat) and putting
its update channel under quorum multisig. Everything else in Sprint 4 is
engineering; this one is custody.

The app currently runs on a **development** upgrade link
(`pear://os5tpkgk8d1fajhfj5q8h9szc6ow7yk4ewy1cw91yhnk3go5gr1o`, see
`apps/chat/package.json`). That key exists on one developer machine and must not
ship — see `docs/decisions/0002-publish-round-trip.md`. This ceremony replaces it
with a multisig-gated production link.

Budget: one sitting, roughly 60–90 minutes, plus collecting public keys from the
other signers beforehand.

---

## 0. What the ceremony produces

Fill this table in as you go. When complete, hand a copy back to the engineering
team (it is the input to the remaining Sprint 4 release work) and store one with
the key backups. **Nothing in this table is secret** — secrets never leave the
signing machines.

| # | Value | Produced by | Filled in |
|---|-------|-------------|-----------|
| 1 | Production **multisig link** (`pear://…`) | step 5, `pear multisig link` | `__________________` |
| 2 | **Namespace** string chosen for the multisig config | step 4 | `__________________` |
| 3 | **Quorum** (e.g. 2 of 3) | step 4 | `__________________` |
| 4 | Signer 1 public key (z32) + key name + machine | step 2 | `__________________` |
| 5 | Signer 2 public key (z32) + key name + machine | step 2 | `__________________` |
| 6 | Signer 3 public key (z32) + key name + machine | step 2 | `__________________` |
| 7 | **Provision link** (`pear://…`, target of the first provision) | step 6, `pear touch` | `__________________` |
| 8 | First provision **versioned link** (`pear://0.0.<key>` bootstrap form) | step 6 | `__________________` |
| 9 | Date, operator, CLI version (`pear versions`) | step 1 | `__________________` |

---

## 1. Prerequisites — check before generating anything

1. **Pear CLI 3.2.0 or later on every signing machine.** Run `pear versions` and
   confirm. The multisig flow below assumes 3.2.0 semantics (a real
   `pear provision --dry-run`, z32-encoded keys in `--json` output). Install or
   upgrade from <https://install.pears.com> if older. Do not run the ceremony on
   3.0.1 or earlier — `--vanity` and current `--json` shapes do not exist there.
2. **Three separate machines, not three keys on one laptop.** Decision 0005
   (`docs/decisions/0005-distribution-channels.md`) is explicit: custody is a
   question of who runs what, and `pear multisig` refuses to issue a signing
   request unless the source drive is seeded by **two other peers** — one machine
   cannot satisfy that. Each signer needs their own machine with the Pear CLI.
3. **A clean, up-to-date OS on each signing machine.** These keys gate every
   update every install will ever receive. Treat the machines accordingly: full
   disk encryption, current patches, no untrusted software. The signing keys are
   encrypted at rest with a password you choose in step 2 — use a real password
   manager, not a sticky note.
4. **Decide the quorum and namespace before you sit down.** Recommended and
   already scaffolded in `apps/chat/pear.json`: **3 signers, quorum 2**. The
   namespace is an arbitrary string that becomes part of the link's identity
   (the link is derived from namespace + public keys + quorum alone, so it can
   never be changed without changing the link). Suggested:
   `lightchain/chat-production`. Pick once.
5. **Do not confuse the two identities.** The Pear release identity (this
   ceremony) is independent of the Windows Authenticode certificate from
   `docs/decisions/0003-windows-signing.md`. The certificate makes the OS trust
   the binary; the multisig link is what the binary polls for updates. Both
   become load-bearing at the first signed release and neither rotates cheaply.
   If you ship MSIX, its `Publisher` field must match the certificate CN exactly
   and permanently — that is settled in the signing procurement track (R-2), not
   here.

---

## 2. Each signer generates a signing key (each signing machine)

Each of the three signers, on their own machine:

```bash
pear multisig keys get
```

- First run prompts for a password to **encrypt** the new private key (it errors
  if none is supplied), then prints the key name and public key. The keypair is
  stored under `~/.pear`. The command is idempotent — re-running reprints the
  existing public key, so you can always recover the *public* half later.
- `pear multisig keys paths` prints the exact on-disk locations of the public
  and private key files. Record them for step 8 (backup).
- Each signer sends **only their public key** to the person assembling the
  config (presumably you). Private keys never move.

Fill rows 4–6 of the table.

---

## 3. Update `apps/chat/pear.json` — the multisig config

`pear.json` already carries the scaffold. Replace the placeholder values — note
the scaffold's `namespace` is the upstream template's
(`holepunchto/hello-pear-electron`) and **must** be replaced too:

Before (current scaffold):

```json
{
  "multisig": {
    "publicKeys": ["<PUBKEY_HERE>", "<PUBKEY_HERE>", "<PUBKEY_HERE>"],
    "namespace": "holepunchto/hello-pear-electron",
    "quorum": 2
  }
}
```

After:

```json
{
  "multisig": {
    "publicKeys": ["<signer-1-pubkey>", "<signer-2-pubkey>", "<signer-3-pubkey>"],
    "namespace": "lightchain/chat-production",
    "quorum": 2
  }
}
```

The provision (source) link is deliberately **not** part of this config — it is
supplied per release, when signing requests are prepared and committed.

---

## 4. Compute the production multisig link

From `apps/chat/` (the directory containing the edited `pear.json`):

```bash
pear multisig link
# pear://<multisig-key>
```

This link is derived from `namespace` + `publicKeys` + `quorum` alone. Any later
change to any of the three produces a **different** link — i.e. a different
update channel — so treat the config as frozen after this step.

Fill rows 1–3 of the table.

Sanity-check what the link enforces:

```bash
pear info --multisig pear://<multisig-key>
```

Confirm the printed public keys and quorum match your table exactly.

---

## 5. Point `apps/chat/package.json` at the production link

Before:

```json
"//upgrade": "Development link. …",
"upgrade": "pear://os5tpkgk8d1fajhfj5q8h9szc6ow7yk4ewy1cw91yhnk3go5gr1o",
```

After:

```json
"//upgrade": "Production multisig link, minted in the key ceremony (docs/key-ceremony.md). Derived from the multisig config in pear.json; changing namespace, publicKeys or quorum changes this link.",
"upgrade": "pear://<multisig-key>",
```

Every shipped build polls this `upgrade` field for updates, and the app refuses
to boot without a valid link — so this edit is what actually moves the product
onto the production channel. Commit both file edits together (suggested message:
`Point chat at the production multisig link`).

---

## 6. Bootstrap the provision drive

Production releases flow `stage → provision → multisig commit`. The multisig
drive's write access comes from the signing quorum, but each release is prepared
against a **provision** (pre-production) drive. Create it:

```bash
pear touch
# pear://<provision-key>
```

Record it in row 7. The first provision against the not-yet-populated
multisig drive uses the bootstrap versioned form `pear://0.0.<multisig-key>` as
the third argument (row 8); after the first commit exists, use the real
versioned multisig link `pear://<fork>.<length>.<multisig-key>` from
`pear info`.

The full first-release sequence (engineering's job after this ceremony, listed
here so you know what your output feeds):

```bash
# from a deployment directory assembled by pear build:
pear stage pear://<provision-or-stage-link> <deployment-dir>   # stage the build
pear provision <source-verlink> pear://<provision-key> pear://0.0.<multisig-key>
pear seed pear://<provision-key>                               # keep it seeded; requests are refused otherwise
pear multisig request <versioned-provision-link>               # prepare signing request
# each signer, on their own machine:
pear multisig sign <signing-request>                           # shares their response
# back on the coordinating machine:
pear multisig verify <source-link> <request> <resp1> <resp2>   # NEVER commit what fails verify
pear multisig commit <source-link> <request> <resp1> <resp2>   # go live
pear seed pear://<multisig-key>                                # seed until peers replicate
```

Remember from decision 0005: `pear multisig request` refuses unless the source
drive is healthily seeded by other peers — plan for always-on seeders (Sprint 4
item R-3) before the first release, not after.

---

## 7. Verify the ceremony

Before declaring done:

1. `pear info --multisig pear://<multisig-key>` — keys and quorum match the table.
2. `pear info pear://<multisig-key>` — resolves without error (it will be empty
   until the first commit; the key material existing is what matters here).
3. `pear stage --dry-run pear://<provision-key> <deployment-dir>` on the next
   engineering build — proves write access to the provision drive and previews
   exactly what would be staged. (Decision 0002: check staged contents with
   `--dry-run` before any first release; `pear stage` does not read
   `.gitignore`.)
4. Fill row 9 (date, operator, `pear versions` output).

---

## 8. Back up the key material (each signer)

The signing keypair lives under `~/.pear`; `pear multisig keys paths` prints the
exact files.

- Copy the **private key file** to two offline backups (e.g. two hardware
  tokens / encrypted USB drives stored in different physical locations). The
  file is password-encrypted, but treat it as if it were not.
- Store the password in a password manager, separately from the key backups.
- `pear multisig keys get --secret` prints the private key if a signer ever
  needs to re-import onto a replacement machine (`pear multisig keys add <name>
  <public-key> [private-key]`).

Failure tolerance, by key type (from the multisig troubleshooting guide):

- **Lose one signer's key:** quorum 2-of-3 still releases. Rotate the config
  (new key, new `pear.json`, new multisig link, new `upgrade` field) at the next
  convenient release — that is a link change, so plan it.
- **Lose two signers' keys:** the production channel is frozen forever. Existing
  installs keep working; no update can ever ship on that link again. This is the
  outcome the backups exist to prevent.
- **Lose the stage/provision drive keys** (they are machine-bound): annoying,
  not fatal — mint a fresh link with `pear touch`, re-provision from production
  (two `pear provision` calls per the troubleshooting guide), nothing in
  `pear.json` changes.

---

## 9. Rollback: if a bad build is staged or committed

Pear drives are append-only; you cannot delete a bad version, you can only
supersede it.

- **Bad stage on the provision/stage drive:** stage the last-known-good content
  again (recover it with `pear dump --checkout <n> <link> <dir>` at the
  last-good version length, then re-stage), or use the advanced
  `pear stage --truncate <n>` to truncate the drive back to length `n`. Nothing
  reaches users until a multisig commit, so a bad stage is cheap.
- **Bad commit on the production multisig drive:** prepare a new signing request
  against a provision of the last-good versioned link and run the normal
  sign → verify → commit flow. The "rollback" is just the next release pointing
  at old content.
- **Interrupted commit:** never `Ctrl+C` a running `pear multisig commit`; if it
  is interrupted anyway, re-run the identical commit command immediately — the
  request and responses are sufficient and it need not run on the same machine.
- **`INCOMPATIBLE_SOURCE_AND_TARGET` on commit:** do not work around it. Mint a
  fresh target with `pear touch`, `pear provision` a clean source onto it, and
  commit against the new link. (See the troubleshooting citation below.)

---

## Sources (local docs mirror)

All semantics above verified against the offline mirror on the dates of Sprint 4
— do not trust older material on the open internet (`pear run` and single-key
`pear release` are removed in Pear 3):

- `docs/offline/pages/reference/pear/cli.md` — `pear touch`, `pear stage`
  (`--dry-run`, `--truncate`), `pear provision`, `pear multisig` subcommand
  table, `pear seed`, `pear info --multisig`, `pear dump --checkout`,
  `pear versions`; 3.2.0 behaviour notes.
- `docs/offline/pages/how-to/operate-an-app/multisig/set-up-multisig.md` —
  key generation under `~/.pear`, the `pear.json` multisig shape, link
  derivation from namespace + keys + quorum, bootstrap provision form.
- `docs/offline/pages/how-to/operate-an-app/multisig/sign-with-multisig.md` —
  request → sign → verify → commit, healthy-seeding precondition, seeding the
  committed drive.
- `docs/offline/pages/how-to/operate-an-app/multisig/troubleshoot-multisig.md` —
  interrupted commits, `INCOMPATIBLE_SOURCE_AND_TARGET`, machine-bound vs
  non-machine-bound drives, provision-drive recovery.
- `docs/offline/pages/how-to/operate-an-app/manual-deployment/deployment.md` —
  the eight-step release flow and what the `upgrade` field does per release
  line.
- `docs/decisions/0002-publish-round-trip.md` — why the dev link must not ship;
  `--dry-run` before first stage.
- `docs/decisions/0003-windows-signing.md` — the separate Authenticode identity.
- `docs/decisions/0005-distribution-channels.md` — three-machines custody
  requirement.
