# Fact-check of the Pear/Holepunch proposal against Lightchain source

Audit date: 15 August 2026. Method: all 48 `lightchain-protocol` repositories pushed on or
after 1 January 2026 were cloned to `lightchain/` and read directly. Every finding below
cites a real file and line. Where a claim could not be substantiated it is marked NOT FOUND
rather than softened.

Verdict counts across 31 checked claims: 9 verified, 14 partially true or overstated,
6 wrong, 2 unverifiable. Four material omissions were also found.

---

## 1. Errors that must be fixed before this goes to a vote

These are claims a technically literate community member could disprove in an afternoon.

### 1.1 TEE attestation is not implemented

The proposal lists TEE attestation among the consensus stack's existing strengths
(Section 4.4) and states that "TEE attestation and payload encryption" are unchanged
(Section 5 diagram). Neither is supportable.

- Searching `lightchain-worker` for `SGX`, `SEV`, `TDX`, `Nitro`, `TEE`, `attestation`,
  and `enclave` returns zero matches.
- `AIVM/cmd/aivm-attestation/main.go:20` prints
  `"aivm-attestation starting (stub). addr=%s"`. The binary is a scaffold.
- The official documentation says so plainly, in
  `lcai-docs/.../aivm-el-architecture.md:68`: "Currently, there is no cryptographic proof
  of which model a worker is running — the canary jobs and dispute system provide economic
  deterrence against cheating. The production system will solve this definitively through
  TEE-based hardware attestation".
- `PoI-Consensus/.../IMPLEMENTATION_STATE_MAPPING.md:163` marks Model Privacy red:
  "No secure enclaves or MPC".

Correct statement: verification today is economic, not hardware-attested. It rests on
canary sampling, semantic similarity scoring, staking, and slashing. TEE is roadmap.

### 1.2 VRF committee selection is a simulated hash, not a VRF

`PoI-Consensus/consensus-go/pkg/intelligence/task_fairness.go:688-716` contains the comment
"Currently using simulated VRF (TODO: upgrade to cryptographic VRF with ed25519)" and
selects with `sha256.Sum256(input)` followed by a modulo. `task_fairness.go:204-212` forces
mode to `"simulated"` even when `ed25519` is configured. There is no verifiable random
function and no proof anyone can check.

### 1.3 The PoI RANDAO beacon is a stub

`PoI-Consensus/consensus-go/pkg/randomness/beacon.go:9-35` is a struct and a constructor
with the trailing comment "Rest of the file remains the same...". Real RANDAO exists in
`lightchain-cl`, but that is inherited unchanged from Prysm, not Lightchain engineering.

### 1.4 "No contract changes, therefore no redeployment risk" is false for the live path

This is the load-bearing claim of Workstream 1 and it does not hold at stack level.

- `lightchain-contracts/src/interfaces/IJobRegistry.sol:76-77` declares
  `bytes32 promptBlobHash;` and `bytes32 responseBlobHash;`. Line 345 documents them as
  "The EIP-4844 blob versioned hash". These are fixed-width hashes, not opaque strings.
  A Hypercore key cannot be stored in them.
- `lcai-smart-contract/contracts/LCAIChatUtility.sol:27` declares
  `uint256 public constant MAX_IPFS_HASH_LENGTH = 64;` and enforces it at lines 344, 387,
  425, and 453. This contract *is* deployed (chain 504, `0x4b1b12f5A60bBD0F2632AebAbE189FE1C02498D4`).
  Many CIDv1 and `pear://` style references exceed 64 bytes and would revert.
- `AIVMInferenceV2.sol` anchors PoI as `bytes32 resultHash` and `bytes32 transcriptHash`.

What *is* true, and should be the actual claim: `AIVMModelRegistry.sol` and
`BenchmarkRegistry.sol` store `baseModelCID`, `variantCID`, `reportCID`, `benchmarkCID`,
and `metadataCID` as `string` with empty-only validation, so those specific fields would
accept a different reference format without a type change.

Two caveats even there. In `AIVMModelRegistry` the field is `metadataHash`, not
`metadataCID`. And neither registry appears in `deploymentsHistory.json`; `Old_AIVM` docs
state "Pending deployment of AIVMModelRegistry to testnet". The proposal cannot lean on
immutable deployed contracts that are not deployed.

### 1.5 Prompt and response artifacts do not go to IPFS today

The proposal's premise for Workstream 1 is that PoI prompt and response artifacts are
published to Lighthouse. The live path is EIP-4844 blobs.

- `AIVM/AIVM Technical Lifecycle Flow.md:220` names Native Blob Transactions as the DA
  mechanism; lines 261 and 275 place IPFS/Filecoin as cold storage after pruning.
- `lightchain-worker/internal/service/service.go` submits response payloads as blobs.
- `lightchain-contracts/src/AIConfig.sol:113` sets `blobRetentionPeriod = 1_555_200`
  (18 days), and lines 258-259 enforce
  `blobRetentionPeriod >= disputeWindow + resolutionTimeout` on chain.

The sentence the proposal quotes is real but comes from a single line in
`lcai-smart-contract/README.md:45`, and that line already conflicts with AIVM's own
lifecycle document and with the running worker.

### 1.6 The chat product is not purely centralized SaaS

- `@vercel/blob` is a dependency but is never imported in `lcai-chat-v2`; the only call
  site is commented out at `lcai-consumer-api/src/routes/chats/export.ts:341-357`.
- `@upstash/redis` is not in the dependency list at all. `resumable-stream` exists but
  `getStreamContext` in `lib/stream-utils.ts` is never imported — dead code.
- Neon is a README recommendation (`README.md:18-19`); the driver is plain `postgres.js`
  against `POSTGRES_URL`.
- The vLLM endpoint is used for title generation, not the chat path.
- With `NEXT_PUBLIC_USE_PROTOCOL=true` (the value in `.env.example`) the client encrypts,
  uploads a blob through the gateway, calls `submitJob` on chain, and receives results over
  the relay. `lib/protocol/session.ts:800-822` and `:461-480` are real `writeContract` calls.

The honest framing is that the UI, chat history, and control plane are centrally hosted
while inference dispatch and settlement already run through the protocol.

---

## 2. Counts and quotes that need correcting

| Proposal statement | Reality | Source |
| --- | --- | --- |
| "16 PowerShell scripts, 16 Bash scripts" | 17 and 17 on disk; 16 and 16 excluding `secrets.example.*` | recursive glob of `lightchain-worker-toolkit` |
| "9 onboarding phases, and 9 guides" | Correct, phases `00`-`08` | `README.md:200`, `docs/` |
| "32 scripts" | 34 files on disk, and the two sets mirror each other, so a single operator runs 9 | `README.md:224-234` |
| `lcai-chat/lib/utils/ipfs-helpers.ts` | NOT FOUND. Real paths are `lcai-chat/lib/ipfs/upload-client.ts` and `lcai-chat-v2/lib/utils/ipfs-helpers.ts` | filesystem |
| `metadataCID` in `AIVMModelRegistry` | Field is `metadataHash`; `metadataCID` is in `BenchmarkRegistry` | `AIVMModelRegistry.sol:44-70` |
| "ECIES and AES-256-GCM" | AES-256-GCM verified. Transport is P-256 ECDH plus AES-GCM, ECIES-like but not labelled ECIES in code | `lightchain-shared-pkg/crypto/session_key.go:26-28` |
| "Celestia ... already named as an option in our architecture docs" | One line in `lcai-smart-contract/README.md:45`. NOT FOUND in PoI, AIVM, or `lcai-docs` | search |
| Dispute window as a single number | Three different values in use, see below | multiple |

The toolkit quote is exact. `lightchain-worker-toolkit/README.md:10` reads: "The official
docs at workers-testnet.lightchain.ai/run-node are correct, but they assume a bash shell,
leave several real-world failure modes undocumented, and require a lot of
copy-paste-edit-pray."

`start-ipfs.sh` is real but starts a self-hosted Kubo node (`ipfs/go-ipfs:v0.24.0`), not
Lighthouse. It is evidence *against* a pure commercial-pinning dependency in that lab setup.

### Dispute window values

| Source | Value |
| --- | --- |
| `lightchain-contracts/src/AIConfig.sol:106-107` | 3600 s dispute, 7200 s resolution |
| `lightchain-contracts/src/AIConfig.sol:113` | 1,555,200 s blob retention (18 days) |
| `lcai-docs/.../governance.md:88` | 24 hours |
| `AIVMModelRegistry.sol:295-301` | 48 hours for model-variant challenges |
| `PoI-Consensus/.../consensus.yaml:141-145` | 8 slots open, 8 slots evidence (~96 s at 12 s slots) |

Any statement about retention outlasting "the dispute window" must name which one.

---

## 3. Material omissions

These matter more than the errors, because three of them strengthen the case for the
proposal and the proposal does not use them.

### 3.1 The control plane is foundation-hosted, and that is the real centralization

The proposal never mentions this. It is the strongest available argument.

| Service | Repository | Who runs it |
| --- | --- | --- |
| Dispatcher, `dispatcher.mainnet.lightchain.ai` | `lightchain-dispatcher` | Foundation |
| Worker gateway, `worker-gateway.mainnet.lightchain.ai` | `lightchain-protocol/worker-gateway` | Foundation |
| Consumer relay | `lightchain-relay` | Foundation |
| Disputer, holds session keys | `lightchain-disputer` | Foundation |
| Blob submitter key | `lcai-consumer-api` gateway | Foundation |

`lightchain-worker-toolkit/docs/architecture.md:47-51` labels the dispatcher and worker
gateway "Lightchain-hosted". The official docs concede it directly in
`aivm-el-architecture.md:91-93`: "The job dispatcher is currently a centralized service".
Terraform modules for `dispatcher`, `relay`, `worker-gateway`, and `gpu` live in
`lightchain-protocol/terraform/modules/`.

Job intake, worker selection, consumer transport, and dispute adjudication are all
single-operator services today. Staked workers are decentralized; the routing between them
is not.

### 3.2 There is no model distribution mechanism at all

The proposal frames Workstream 3 as replacing "central download servers". No such servers
exist. `lightchain-worker/internal/ollama/client.go:161-209` only calls `GET /api/tags` to
verify a model is present and logs a non-fatal warning if not. Operators run `ollama pull`
by hand, out of band.

This makes model delivery a gap to fill rather than a system to replace, which lowers its
risk substantially and is worth saying.

### 3.3 The worker is distributed as a Docker image, not a binary

`lightchain-worker` is Go 1.26, but operators consume it as a container from
`us-central1-docker.pkg.dev/lightchain/lightchain-*-public-docker/worker:latest`
(`scripts/powershell/env.ps1:12`). Updates today are a manual digest comparison followed by
pull and restart, documented at `docs/operations.md:222-257`, which explicitly notes "No
re-registration needed". A Pear supervisor would orchestrate Docker and Ollama, not replace
a native binary.

### 3.4 Omitted operator prerequisites

The proposal lists Docker, Ollama, and `cast`. The README also requires 8 GB of GPU VRAM
minimum (`README.md:265-281`), approximately 50,005 LCAI in a funded wallet, and a
50,000 LCAI stake locked at registration (`README.md:233`). Leaving out the stake
requirement makes the onboarding story misleading in the operator's favour.

---

## 4. Claims that stand

- `lcai-consumer-api/src/lib/lighthouse-ipfs.ts:5` and `:34` match the proposal exactly,
  including the `upload.lighthouse.storage` host, the bearer token, and a single-gateway
  read path with no fallback loop.
- `Old_AIVM/storage/ipfs/lighthouse_client.py` is a genuine Lighthouse client.
- The three `lcai-chat` IPFS API routes exist at the stated paths.
- Lighthouse writes are gated by one API key and reads by one gateway. `lcai-chat`'s
  `IPFS_GATEWAYS` is a one-element array despite a "with fallbacks" comment
  (`sdk/inference/src/constants.ts:82-85`).
- Commit/reveal, BLS aggregation, LMD-GHOST, bonded challengers, and dispute windows are
  real, substantial Lightchain code in `PoI-Consensus`.
- `lightchain-el` is a go-ethereum v1.17.0 fork; `lightchain-cl` is a Prysm v7 fork with
  inactivity-exit enforcement added after the 11 August 2026 mainnet halt.
- Gossipsub is deeply integrated: 8 topics joined at startup and 11 canonical `lc/*/v1`
  envelope names.
- EVM state stays in geth. No alternative state store is present.
- The web client does settle sessions on chain, so holding a Pear client to that bar is
  meaningful rather than vacuous.

---

## 5. Maturity note

`PoI-Consensus` is version 0.1.0 and its own release notes say "ALPHA release - not
production-ready for mainnet... Recommended for testnet use only"
(`release/v0.1.0/README.md:247-250`). It runs on chain ID 504, `lcai-testnet-v2`. The Prysm
fork has production history, including a mainnet halt on 11 August 2026. Describing the two
as one mature consensus stack overstates the position.

The Go `AIVM` is a scaffold: all four `cmd/` entry points print "(stub)", and
`internal/crypto/` and `internal/da/` contain only `.gitkeep`. `Old_AIVM` is the fuller
Python implementation.
