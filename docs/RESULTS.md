# RESULTS.md

Onchain proof for every claim this project makes. Each entry carries a transaction hash and an explorer link. Nothing is listed that has not actually executed.

Network: Arc Testnet (chain id 5042002) and Base Sepolia (84532). Testnet only.
Run dates: 2026-07-27 (v2), 2026-08-05 (v3), 2026-08-09 (v4).

The vault is immutable, so each change of shape is a new address and the older deployments keep their proofs. This document is organised by deployment for that reason: nothing is deleted or rewritten when a successor ships, because the record of proving something when it shipped is part of what is being claimed.

| Deployment | Address | Carries | Status |
| --- | --- | --- | --- |
| **v4** | [`0x3b50...d498`](https://testnet.arcscan.app/address/0x3b507607bA48A65587a9a6136c36cd2f1132d498) | everything below, plus the pull oracle with a confidence guard and the correctness fixes | **current**, all public claims link here |
| v3 | [`0xDC00...7300`](https://testnet.arcscan.app/address/0xDC0040eB02c438D59838A6f178e38184eACf7300) | recurring and sweep scheduling | superseded, read-only |
| v2 | [`0xB702...09D1`](https://testnet.arcscan.app/address/0xB702404EA947aec698323Cd42989CA6168f209D1) | the four condition types and the Pyth oracle | superseded, read-only |

All twelve capabilities are re-proven on v4, below. The sections after the v4 material are the v2 and v3 record, kept complete and unchanged.

---

## v4 migration

v4 was deployed because a correctness defect was found in the deployed Oracle condition: a feed answer dated ahead of the current block underflowed the staleness check and reverted the read instead of failing closed. The vault is immutable, so the fix required a deployment, and the generic pull-oracle adapter was folded in rather than paid for twice. See DECISIONS D13 and D14.

### Deployed contracts

Costs are read from the Foundry broadcast artifacts, not from a terminal. Gas is USDC on Arc, so these are dollars.

| Contract | Address | Deploy tx | Cost |
| --- | --- | --- | --- |
| PolicyVault v4 | [`0x3b507607bA48A65587a9a6136c36cd2f1132d498`](https://testnet.arcscan.app/address/0x3b507607bA48A65587a9a6136c36cd2f1132d498) | [`0x770e20c9…`](https://testnet.arcscan.app/tx/0x770e20c925aa598f3a30fb529b3b6daa177eb67a27ac0b0eb4321d898cdc7970) | 0.079725 USDC |
| PythAdapter | [`0x0A5fD210414e68a5C0690B890a165E35D4E6Acef`](https://testnet.arcscan.app/address/0x0A5fD210414e68a5C0690B890a165E35D4E6Acef) | [`0x8347ed8d…`](https://testnet.arcscan.app/tx/0x8347ed8dca85470ee30bb611ad3bf50318db58b3d0fa3d85fd8a8fc8471ee2cf) | 0.014311 USDC |
| FutureDatedAggregator | [`0x8e993287fb52f20c7E85F68A69730a6A11d99165`](https://testnet.arcscan.app/address/0x8e993287fb52f20c7E85F68A69730a6A11d99165) | [`0xfeff2bb9…`](https://testnet.arcscan.app/tx/0xfeff2bb9c7eb0519b1779e9f41c768994a4ca31e38e341825984a52d9a58d916) | 0.003892 USDC |
| ConditionProbe | [`0x7E6d93Bf959e0f26715b685Dd8d02c104214f923`](https://testnet.arcscan.app/address/0x7E6d93Bf959e0f26715b685Dd8d02c104214f923) | [`0xf8eed7c3…`](https://testnet.arcscan.app/tx/0xf8eed7c3607a15bd739449f8c5e2c4677fa5ead0c15546bfa8c61cb576bc6fe4) | 0.002991 USDC |

The last two are proof instruments for the fail-closed demonstration, not part of the settlement system.

### Deploy cost grows with the contract, and is stated per deployment

| Deployment | Gas | Cost |
| --- | --- | --- |
| v1 | 1,386,095 | 0.029385 USDC |
| v2 | 2,368,402 | 0.059210 USDC |
| v3 | 3,191,622 | 0.068620 USDC |
| v4 | 3,796,416 | 0.079725 USDC |

Each version added condition types, so each cost more to deploy. Quoting one figure as "the" deployment cost would be wrong for three of the four; the current vault costs **eight cents**, not the six that v2 did.

### Migration: cancel and refund

Nine policies across v2 and v3 were Pending. Five of them back proofs cited in this document, and cancelling those would have made published negative proofs non-reproducible: the recorded revert reason would change from `ConditionNotMet` to `PolicyNotPending`. One, the v3 sweep, is a live-state proof whose cited claim is that it stays active, so cancelling it would have falsified the claim outright.

Only the two policies that held recoverable funds and back nothing were cancelled. The hashes below are recovered from `PolicyCancelled` logs onchain rather than copied from a terminal.

| Cancelled | Why | Refunded | Tx |
| --- | --- | --- | --- |
| v2 policy 5 | a `≤ 0.99` depeg policy holding 0.50 USDC, permissionlessly releasable on a vault about to go unwatched | 0.500000 USDC | [`0x1f68c878…`](https://testnet.arcscan.app/tx/0x1f68c878c1ab4f0d72d89e6cc9d3fbed54aff2f1227fca057be84fe3f71d413f) |
| v3 policy 1 | uncited recurring policy, 0 of 5 periods released | 0.020000 USDC | [`0x65ebf40a…`](https://testnet.arcscan.app/tx/0x65ebf40a2c45c4fdebd9af29249e601aafd63873725ca02835a43af569f7c4b5) |

Treasury balance moved 0.920604 to 1.436688 USDC, a delta of 0.516084 against 0.520000 refunded. The difference is gas, which on Arc is USDC.

Deliberately left untouched, and still Pending on their read-only vaults: v2 policies 3, 8, and 9, and v3 policies 3 and 5.

### Re-proof preamble: balances before the first transaction

The pass was funded up front rather than topped up as it ran. The timings below are part of what is being proven, so a pause for funding would leave an unexplained gap in the middle of them.

`npm run v4:preflight` computes the requirement per row, applies a 1.5x margin, and refuses to report ready until every wallet clears it. Balances at the moment the pass began:

| Wallet | Address | Required | Held at start |
| --- | --- | --- | --- |
| Treasury (Arc) | `0x4fe35042fa4e8ca187ec0b65c06b4037bebaa6e5` | 2.000000 | 21.436688 USDC |
| Executor (Arc) | `0x556328348c9c71fd77f31d86a2c2c989beb42671` | 0.610000 | 4.325883 USDC |
| Executor (Base Sepolia) | `0xf4f3445a894aeb10fcbfcce697c9422f9c1ecb73` | 0.000000 | 2.233468 USDC |

The executor's requirement is separate from the policy amounts and is not a duplicate of them. Transit fees are deducted from the amount in flight, and the recipient is grossed up from the executor's own balance so it never receives less than the policy names, so a cross-chain settlement costs the executor real money beyond what the vault releases. See D6 and VERIFICATIONS V17 and V18.

---

## v4 re-proof: all twelve capabilities

Fourteen policies created, thirteen releases, and every settlement recorded. The tables in this section are generated from onchain events and the executor's settlement store rather than copied from a terminal, and every revert reason below was decoded from the transaction rather than assumed from the script that produced it.

### 1 and 3: FX settlement on Arc, approval condition

Policy 0. An N-of-M approval releases 0.50 USDC, which is swapped to EURC and paid on Arc.

| Step | Tx |
| --- | --- |
| create | [`0xe0bc8928…`](https://testnet.arcscan.app/tx/0xe0bc892823f0cdc57e3a9f699bc26f80fb68b7a8ff756f32e5e0f567d5b208b2) |
| release | [`0x888d1547…`](https://testnet.arcscan.app/tx/0x888d154757d7f4c9470c6633f1277e97fc487c340a662dbbbb9ae6c470a368b4) |
| fx, produced 0.442082 EURC | [`0xcc3cb212…`](https://testnet.arcscan.app/tx/0xcc3cb21202374d3efbfcb49c1e7b4bff79949ab80d423b41ea9bb6b16f796080) |
| payout | [`0x3e66da8a…`](https://testnet.arcscan.app/tx/0x3e66da8aa67fe5382a79570a17613b6af0281a2d5e1e7bb59321aa67e9b66c8e) |

**Settled in 11.8 seconds.** The equivalent on v2 took 16.6 seconds. That difference is network variance between two runs on a public testnet, not a v4 improvement, and is not claimed as one.

### 2: Cross-chain settlement, Arc to Base Sepolia

Policy 1. 0.50 USDC released on Arc, burned via CCTP, and minted directly to the recipient on Base Sepolia. The mint is the payout: there is no separate transfer, so the recipient needs no gas token.

| Step | Tx |
| --- | --- |
| create | [`0x2d8da699…`](https://testnet.arcscan.app/tx/0x2d8da699226c6ae5997c7ce8e1880d1db1701af0a44db9cd357b6cec052e5337) |
| release | [`0x733842b8…`](https://testnet.arcscan.app/tx/0x733842b8852df92c0b1e0eb4e6fc4d31be71cb84d55dd12cc9906ea68f39e086) |
| bridge and mint, on Base Sepolia | [`0xfbc2a141…`](https://sepolia.basescan.org/tx/0xfbc2a1419cf614e12f66090afdaeaa3608abd252e09eced5b32f36122ad6d369) |

**Settled in 31.5 seconds.**

### 4: Attestation, EIP-712

Policy 2. A named attester signs a statement bound to the policy id and this contract; anyone may carry the signature onchain.

| Step | Tx |
| --- | --- |
| create | [`0x669442f1…`](https://testnet.arcscan.app/tx/0x669442f1ae66cba14ed5a41ee76332a8fd4778cc6217fcfe2d44cb9ec46c1f5f) |
| attest | [`0xd992291f…`](https://testnet.arcscan.app/tx/0xd992291fc09093ddebf37eddf77e72d67d892c88b63dd7083a39a37dba36b8db) |
| release | [`0xa55b32c3…`](https://testnet.arcscan.app/tx/0xa55b32c39736f3bf10f9f02fe74be8e1ddaedd74d6329f8c2ac6ef1be9c33148) |
| payout | [`0x8a4e4e75…`](https://testnet.arcscan.app/tx/0x8a4e4e7571fa620da4af3bc140abdabf6737be33b02b854f7ce814de18098989) |

**Settled in 3.7 seconds.** Attester `0x68BF5394FB1a2Ed52b83259410CdF1FBaa9a25c1`.

### 5: Oracle, pushed feed

Policy 3, releasing while USDC/USD holds at or above 0.995, read through the official PythAggregatorV3 wrapper. This is the simpler oracle path: the price must be refreshed before release, and the interface carries no confidence interval to check.

| Step | Tx | Note |
| --- | --- | --- |
| create | [`0xf40a766f…`](https://testnet.arcscan.app/tx/0xf40a766f3efcaee0ac8d6fe6ddc667e1bcaa09d732ce3d24277e56a762a6c7fd) | Gte 0.995 |
| update | [`0x395586b5…`](https://testnet.arcscan.app/tx/0x395586b5864dc5a7c1b05e319d2951b4f779d9ea9203be1752afe765a2dcd628) | Pyth USDC/USD 0.99987, fee 1 wei |
| release | [`0x3c0820aa…`](https://testnet.arcscan.app/tx/0x3c0820aa174caa38335dd51899ff95b1ac2e1ff55699a4c2ddfefb144d626e31) | condition met |
| payout | [`0x31b22b32…`](https://testnet.arcscan.app/tx/0x31b22b3265e22d7bb806c8931b70212b7a016220c659fd0be06b6192bca7cbc3) | **3.9 seconds** |

Both negatives refused onchain, each with its reason decoded from the transaction:

| Failure | Decoded reason | Tx |
| --- | --- | --- |
| threshold unmet, policy 4 | `ConditionNotMet(4)` | [`0x5c9a5a58…`](https://testnet.arcscan.app/tx/0x5c9a5a58954412196e4c0c84226db2ae9e0dd293465dd6f8dfbfa248dca3d208) |
| stale price, policy 5 | `ConditionNotMet(5)` | [`0x97828272…`](https://testnet.arcscan.app/tx/0x97828272a6defde9d81c44e9206d773795682c60af1f57f809ce3116ae83f8d2) |

### 6 and 7: Pull oracle, atomic release and confidence rejection

The path v4 adds, and the one new policies default to. A signed price update is verified and the release performed in a **single transaction**, and a price the oracle itself is unsure about is refused.

Live quote at the time of the run: **0.999850 with a confidence interval of ±0.000801**, a spread of 8.01 basis points.

| Step | Policy | Tx |
| --- | --- | --- |
| create | 6 | [`0x2bbbab15…`](https://testnet.arcscan.app/tx/0x2bbbab1511cf75b3482d576a6912634dbd91fa89619156b639c7cc319354522b) |
| **verify and release, one transaction** | 6 | [`0xd3b61052…`](https://testnet.arcscan.app/tx/0xd3b61052075edc0dc7c898bab60fd41ee59368e6a4dd30b581a205115b06dc38) |
| create with a 4 bps confidence bound | 7 | [`0x7ae9e9f3…`](https://testnet.arcscan.app/tx/0x7ae9e9f30888da163bb4360e71057cde60a40b3f91e4dd7836f96e3d01f129b2) |
| **refused, confidence too wide** | 7 | [`0x140f079b…`](https://testnet.arcscan.app/tx/0x140f079bbc20d43f65df8b0556b8e8829943b25c68bb07b0ebdfc2f2c3e0d2d2) |

The refusal decodes to `ConfidenceTooWide(7, 801260000000000, 999849740000000000, 4)`: the price crossed the threshold and was still refused, because the oracle's own uncertainty of 8.01 bps exceeded the policy's 4 bps bound.

The bound was chosen at runtime as half the live spread so the rejection would be demonstrable against real data rather than waiting for market stress. That is an engineered condition on a real quote, stated plainly, the same way the depeg band is framed.

### 8: Fail closed on a future-dated answer, the defect that forced v4

The staleness check subtracted a feed timestamp from the block timestamp outside the guard that catches a bad feed, so an answer dated ahead of the block underflowed and reverted the read instead of returning false.

Pyth cannot be asked to publish a future timestamp on demand, so the feed is a synthetic [`FutureDatedAggregator`](https://testnet.arcscan.app/address/0x8e993287fb52f20c7E85F68A69730a6A11d99165): a valid, positive, complete answer whose only unusual property is that it is dated 300 seconds ahead. **The vaults are the real deployed ones.** What is being proven is the vault's guard, not the price's meaning.

`checkCondition` is a view and produces no transaction, so [`ConditionProbe`](https://testnet.arcscan.app/address/0x7E6d93Bf959e0f26715b685Dd8d02c104214f923) calls it and emits the result, making the read observable.

| Vault | Action | Status | Decoded reason | Tx |
| --- | --- | --- | --- | --- |
| v3, defective | probe `checkCondition` | reverted | `Panic(0x11)` arithmetic underflow | [`0x869722a5…`](https://testnet.arcscan.app/tx/0x869722a56735356227851ac39e3dfda2d58351b5d775f78409ef9f18d1e4f192) |
| v3, defective | release attempt | reverted | `Panic(0x11)` arithmetic underflow | [`0x3823a985…`](https://testnet.arcscan.app/tx/0x3823a985c1ad10c1ac988fb5959166d6f5623cda2da48de7dd1aa6bf7f363d54) |
| **v4, fixed** | probe `checkCondition` | **success** | emitted `Probed(met=false)` | [`0xfa9e6fec…`](https://testnet.arcscan.app/tx/0xfa9e6fecac4c6ac8b3d6c6f174a904c6fbc65eb14dbcf3a0f7da0281cf52ce0a) |
| **v4, fixed** | release attempt | reverted | `ConditionNotMet(8)` | [`0xe65973ac…`](https://testnet.arcscan.app/tx/0xe65973ac90078ea09476b73e14fa9a495226410dd2f2a8395f43ed4f75deda48) |

Identical feed, identical policy configuration. Every one of these transactions except the third fails with status 0, so the status alone would suggest the two vaults behaved the same. **The decoded reason is the evidence:** v3 cannot read the condition at all, v4 reads it and declines cleanly.

One write was made to v3 after it was set read-only, and this is it: the unfunded oracle policy 8 pointing at the synthetic feed, created solely to produce this comparison. It holds no funds and can never release on either vault. It is the sole exception to v3 being closed.

### 9: Recurring payroll

Policy 9, 0.01 USDC every 4 seconds for 3 periods, then it retires. Each period is a separate release that settles on its own.

| Period | Release | Payout |
| --- | --- | --- |
| 1 | [`0xec251b7d…`](https://testnet.arcscan.app/tx/0xec251b7d328395069b759f44175b542da8d7af2830de0a87b9d3c17b1ce7f3be) | [`0x663dc0d8…`](https://testnet.arcscan.app/tx/0x663dc0d83a15483e80aac1c62fa657a81980fc270fa1a68cd22dcf2f71d8d35d) |
| 2 | [`0x088edf0b…`](https://testnet.arcscan.app/tx/0x088edf0b6ed97da8f6e0a2cc34df5c12a2865cfe95c5f13de232f19b0d8b55c5) | [`0xf410db77…`](https://testnet.arcscan.app/tx/0xf410db77777a491ec453fec7897ba0e05b197adfdb401a095a4fa4aac74a0fdb) |
| 3 | [`0x61030880…`](https://testnet.arcscan.app/tx/0x61030880adb90c4249af51d8b106570b64b9491d7ed358a9dc1017e424e6cc77) | [`0x3468ecad…`](https://testnet.arcscan.app/tx/0x3468ecad55becd8aa8955baeb0b16071827e9c464e215124948487558d7904ed) |

A period overdue beyond its `maxCatchUp` is not paid automatically. On policy 10 the keeper's attempt refused and only the owner could clear it:

| Step | Decoded reason | Tx |
| --- | --- | --- |
| keeper attempt on an overdue period | `CatchUpStale(10, 1786279596)` | [`0x1c42f1a9…`](https://testnet.arcscan.app/tx/0x1c42f1a904db1c8b9412d7e32169e154c2003376b2db10bff5ac51ca4715ec9d) |
| owner `approveStalePeriod` | released | [`0xa2ac677f…`](https://testnet.arcscan.app/tx/0xa2ac677fbb2d0679dd427ee5f770b8907a306446c1bfbd25c92a6a04f473bc7e) |

### 10: Sweep above a buffer

Policy 11 keeps a 0.05 USDC buffer and releases the excess on schedule, skipping when the excess is below the 0.02 dust floor. Unlike payroll it does not retire.

| Step | Detail | Tx |
| --- | --- | --- |
| sweep 1 | released 0.100000 excess | [`0x03e18c3e…`](https://testnet.arcscan.app/tx/0x03e18c3e0bd3ec0cedbae7a47fdb92ffab28518fcf75141ee1f6f77fe7d87abb) |
| dust floor | `SweepBelowMin(11, 0, 20000)`, buffer preserved | [`0xca43a65b…`](https://testnet.arcscan.app/tx/0xca43a65b3f748f70ec4b5f775b0ea1899e07fbdcb7018356443806acded8de0f) |
| sweep 2, after a top-up | released 0.080000 excess | [`0xb4bffff4…`](https://testnet.arcscan.app/tx/0xb4bffff4dc49c3c7e3f1382700c36391fc2a059057b393525013b3e24013228b) |

0.05 USDC, exactly the buffer, remains in the policy.

### 11: Condition unmet, refused onchain

Policy 12, a timelock 24 hours out, with release attempted immediately.

| Step | Decoded reason | Tx |
| --- | --- | --- |
| create | releasable in 24h | [`0xf13dd9e7…`](https://testnet.arcscan.app/tx/0xf13dd9e7d72fce888da525885a951804fce6081d6eea48180d169b1600592b54) |
| premature release | `ConditionNotMet(12)`, status 0, 33,821 gas | [`0x74c46199…`](https://testnet.arcscan.app/tx/0x74c46199ea5456338f11c6a65aac99764970a52b801098464954543cdb4f34b2) |

Signed by a raw EOA rather than a Circle wallet, deliberately: Circle developer-controlled wallets simulate before broadcasting and refuse to submit a transaction that would revert, which is correct for a payments product and incompatible with evidencing a revert.

### 12: Gateway funding from another chain

0.03 USDC held on Base Sepolia funded an Arc policy with no manual bridge, and reached the recipient.

| Step | Tx |
| --- | --- |
| mint on Arc from the unified balance | [`0xc2fdd440…`](https://testnet.arcscan.app/tx/0xc2fdd4407d2fa0e6025df63368847aee02e3bf156526761884884b70a204005f) |
| create and fund policy 13 | [`0x4f5d4c1c…`](https://testnet.arcscan.app/tx/0x4f5d4c1c2821bd4e9800050f7dcb1331659838d7e2765d5a2a12d2711593b1b5) |
| release | [`0x08f21e5b…`](https://testnet.arcscan.app/tx/0x08f21e5b9839522ddee52ec179c4f393e5410be86c8c114618f28728e86558de) |
| payout | [`0x4d1525cc…`](https://testnet.arcscan.app/tx/0x4d1525cca2e44e1b4f41f2a78fefd4e3bead3a242bb7622692b969acad1e68b9) |

**Settled in 3.6 seconds** from release to paid.

---

## Known defects by deployment

Recorded here so a reader can check whether a proof above was affected by something found later. Nothing in this section is hypothetical.

### Future-dated oracle answer, v2 and v3, fixed in v4

The Oracle condition's staleness check reverted rather than failing closed when a feed answer was dated ahead of the block. Reachable on the ordinary path: the demo is a pull update followed immediately by a release, and a Pyth publish time a second or two ahead of the Arc block timestamp is enough.

It fails in the safe direction. It cannot release funds that should not be released; it fails loud rather than quiet. **Fixed in v4 and proven above in row 8.** The v2 and v3 oracle proofs recorded below remain valid: they ran against a fresh feed, and the defect only affects a future-dated one.

### Settlement store keys carry no vault, all deployments, not yet fixed

The executor keys a settlement record as `policyId:periodIndex`. That key has no vault component, the store persists across deployments, and **every deployment restarts policy ids at zero**. A single store file therefore holds records from several vaults with no way to tell them apart from the key.

No settlement has been affected. Ids have not overlapped within any one file, which is luck rather than design, and the luck is scheduled to run out: when a future deployment numbers a recurring policy the same as an earlier one, `tryClaim` will find the key present, return false, and the engine will log `already claimed, skipping`, which it treats as the normal outcome of a replayed scan. **A real payment would be skipped and reported as healthy.**

This is the same class of mistake as the operator app treating a policy id as unique across vaults, surviving in the last place it was not looked for. It was found while generating this document from source rather than from terminal output, because the generator initially listed settlement records from all three deployments as if they were v4's.

**Trigger, written down so it does not drift: this must be fixed before any v5 deployment.** The fix is to include the vault in the key, matching what the vault registry now does everywhere else, with a migration for existing records. Tracked in DECISIONS D15.

---

## What was proven

A payment that releases only when an onchain condition is met, then routes itself to the recipient across currencies and chains, with no human in the loop after the trigger, and refuses to move when the condition is unmet.

| Claim | Evidence |
| --- | --- |
| Conditional release enforced onchain | policy 1, 2, and 0 releases, below |
| Release refused when condition unmet | policy 3, reverted transaction, status 0 |
| Automatic FX settlement | 0.50 USDC to 0.377398 EURC, paid to recipient |
| Automatic cross-chain settlement | Arc to Base Sepolia via CCTP, paid to recipient |
| Release on a signed attestation | EIP-712 signature, policy 0, paid to recipient |
| Recipient needs no gas token | Base Sepolia recipient paid holding 0 ETH |
| Recipient never short-changed | cross-chain recipient received 0.606602 for a 0.5 policy |
| No double payment on restart | claim-before-work store, 101 executor tests |

## The four condition types

A policy releases when its condition is met. PolicyVault enforces all four onchain:

- **Timelock**: releasable after a timestamp. Demonstrated in the failure path below.
- **Approval**: releasable after N-of-M named approvers call approve. Used by both canary policies.
- **Attestation**: releasable when a named attester signs an EIP-712 statement. Policy 0 below.
- **Oracle**: releasable when a price feed crosses a threshold. Proven onchain against a live Pyth feed (see the Oracle section).

## Deployment (v2)

| Item | Value |
| --- | --- |
| Contract | PolicyVault v2 (four condition types) |
| Address | [0xB702404EA947aec698323Cd42989CA6168f209D1](https://testnet.arcscan.app/address/0xB702404EA947aec698323Cd42989CA6168f209D1) |
| Deploy tx | [0x63b793fa...1d03b62475e](https://testnet.arcscan.app/tx/0x63b793fa52f9809e5a62832be635d537e3e20ae07a6ed2595d6cb1d03b62475e) |
| Cost | **0.059210 USDC** |

Deployment cost is denominated in dollars because USDC is the native gas token on Arc. Deploying this contract cost six cents, known at the moment of deployment rather than exposed to a separate volatile asset. The current vault, v4, carries more and costs eight cents; see the per-deployment table above.

## The canary

`npm run canary` stages two policies and settles them by watching the chain. Nothing tells the executor what to do: it discovers work by scanning for `PolicyReleased`, exactly as it would if the policies had been created by someone else. Both use the approval condition.

Two archetypes rather than one combined flow because EURC has no cross-chain route. CCTP and App Kit Bridge carry USDC only, and Arc is the sole swap-enabled testnet, so a single settlement delivering EURC to another chain is not buildable today.

### Policy 1, FX archetype, entirely on Arc

0.50 USDC released against a 1-of-1 approval condition, paid to the recipient in EURC.

| Step | Transaction | Note |
| --- | --- | --- |
| release | [0xd5a5008b...4a08c27c9](https://testnet.arcscan.app/tx/0xd5a5008b280fcfbe8d2713fc0f4383eadbfadbc038cec4fe504e77d4a08c27c9) | condition met, funds to executor |
| fx | [0x311675d5...cff251d3bb35](https://testnet.arcscan.app/tx/0x311675d57035a9b0bcbea302063c98fc8a5825aa336872a22f98cff251d3bb35) | 0.50 USDC to 0.377398 EURC |
| payout | [0xace9dcdf...bc89f1cb995](https://testnet.arcscan.app/tx/0xace9dcdf797fc9c7efd96391ed17e4d5996f62210f0cfad8eab1dbc89f1cb995) | EURC to recipient |

**Settled in 16.6 seconds**, release to recipient paid.

### Policy 2, cross-chain archetype, Arc to Base Sepolia

0.50 USDC released against a 1-of-1 approval condition, paid to the recipient on Base Sepolia. The burn is grossed up so the recipient receives at least the policy amount after the forwarder fee.

| Step | Transaction | Note |
| --- | --- | --- |
| release | [0xf2ef10c2...5c6131bcee59](https://testnet.arcscan.app/tx/0xf2ef10c2dd7a15cd4f69e0cf6689e3eb175b632cafbae7b750f85c6131bcee59) | condition met, funds to executor |
| bridge | [0x68263cfc...f020253844fe](https://sepolia.basescan.org/tx/0x68263cfcf2f38df680b769a65697cab9b3677f3cabba1b21ae28f020253844fe) | CCTP burn on Arc, mint to recipient on Base Sepolia |

**Settled in 28.8 seconds.** One transaction, not two: the mint lands directly on the recipient, so it is the payout.

## Attestation

`npm run demo:attestation` proves the attestation condition end to end. An ephemeral attester key signs the exact EIP-712 digest the contract exposes via `attestationDigest`, so the signature is bound to this contract, this chain, and this policyId. The attester holds no funds and needs no gas: `attest` is permissionless to submit.

Policy 0, 0.50 USDC, attester `0x22b28ec95Ce8BB421ad2E3E7a3E6F8170D40ad05`, paid in USDC on Arc.

| Step | Transaction | Note |
| --- | --- | --- |
| create | [0x5eef3327...ef4ca5e1883](https://testnet.arcscan.app/tx/0x5eef33270fceda3c1648313be3bc243c6ce67d0e07d5feb1fff8def4ca5e1883) | attestation policy 0 |
| attest | [0xaa1e518a...0f0d438e5659](https://testnet.arcscan.app/tx/0xaa1e518abc7cb2109b381f76735312ba92b63182a9d89d25a0460f0d438e5659) | EIP-712 signature verified onchain |
| release | [0x3f3165e8...bb6a51ba8eed](https://testnet.arcscan.app/tx/0x3f3165e8c58288264691fb3eaf2fdaf2c6e87627840e93c9ecb9bb6a51ba8eed) | condition met |
| payout | [0xed694316...4308cbd3c10247](https://testnet.arcscan.app/tx/0xed694316de606aa2d65f1c4e1215e5802de80739015b4f3f124308cbd3c10247) | USDC to recipient |

**Settled in 6.8 seconds.** Read back from chain: policy 0 conditionType Attestation, status Executed, `attested` true.

## Oracle

The fourth condition type releases when a price feed crosses a threshold, and it is proven onchain against a live Pyth feed. The condition reads a Chainlink-style `AggregatorV3Interface` and is fail-closed for the data faults it was built against: contract tests cover stale, zero, negative, incomplete, and reverting feed data, all read as "not releasable." One case is not covered, and it is stated in full below rather than left inside the qualifier.

Arc testnet does not publish Chainlink push Data Feeds, so there is no Chainlink feed to point at. Pyth, however, is a pull oracle that is deployed on Arc testnet and reachable with no credentials. Pyth ships an official `PythAggregatorV3` adapter that exposes a Pyth feed through the same `AggregatorV3Interface` the condition already reads, so the condition runs against live Pyth data with no change to the vault and no redeploy. The demo is a USDC/USD depeg-protection policy, on the same PolicyVault as every other proof. It is permissionless: the price update is fetched keyless from Pyth's Hermes service and the onchain update fee is 1 wei of native USDC.

Wrapper: [PythAggregatorV3 0xe5095E...188E](https://testnet.arcscan.app/address/0xe5095EDb56bc24C20610DfE8Cc709FE63828188E), over Arc's Pyth contract 0x2880aB155794e7179c9eE2e38200202908C17B43.

| Step | Tx | Note |
| --- | --- | --- |
| create | [0x1536de6d...bb82bd5](https://testnet.arcscan.app/tx/0x1536de6d661ca11c0fa06b918ce3efb4845e770afed824465b3ca7c40bb82bd5) | oracle policy 7, release while USDC/USD >= 0.995 |
| update | [0x47d38440...b31b6a2f](https://testnet.arcscan.app/tx/0x47d38440306d8ec9c2ec76d71c6ebabc828d74639dd129a4c14adf8fb31b6a2f) | Pyth USDC/USD 0.99990, fee 1 wei native USDC |
| release | [0x02173d2f...a3ff80d3](https://testnet.arcscan.app/tx/0x02173d2f68f74800ad3fe7132815d4b09a6bd0a9b5de0bfaf69e6ea1a3ff80d3) | condition met |
| payout | [0xab8670d8...50a4aa130](https://testnet.arcscan.app/tx/0xab8670d8a8246bfc734173ebcf6f3dd0a45859de12e14b04432070450a4aa130) | 0.1 USDC to the recipient on Arc |

Settled in 9.0 seconds. Both failure paths are proven onchain too, each reverting with status 0:

| Failure | Tx | Why it refused |
| --- | --- | --- |
| threshold unmet | [0x8b219f28...3b7f707b](https://testnet.arcscan.app/tx/0x8b219f28d552f2fba5efa276ec0f8d9f5528a417488304474784c61a3b7f707b) | a "release only if USDC/USD <= 0.99" depeg policy, held unmet by a healthy live price |
| stale price | [0x624f6928...86e37aea7](https://testnet.arcscan.app/tx/0x624f6928348ec453333aa919c598f76d62ffe77f78d324a0989351586e37aea7) | maxStaleSeconds exceeded, the fail-closed staleness guard |

The negative policies are deliberately unfunded: release checks the condition before the funding check, so both revert with `ConditionNotMet`, which shows the condition gates release rather than the balance.

Two current limitations, stated plainly.

**Confidence intervals.** v1 checks the price against the threshold through the official Pyth adapter; confidence-interval rejection is designed and lands with the generic adapter, which the `AggregatorV3Interface` surface does not expose. See docs/specs for that design.

**The fail-closed guarantee has a hole in the deployed vault.** A feed answer dated *ahead* of the current block does not read as "not yet." The staleness check computes `block.timestamp - updatedAt`, which underflows when `updatedAt` is in the future, and that arithmetic sits outside the `try` that catches a misbehaving feed. The call reverts instead of returning false, so `checkCondition` and `statusOf` revert with it, and the monitor's read of that policy fails rather than showing it as unmet.

This is not only a bad-feed hypothetical. The demo path is a pull update followed immediately by a release, and a Pyth `publishTime` a second or two ahead of the Arc block timestamp is enough to trigger it. It has not been observed in the runs recorded above, and it does not release funds that should not be released: it fails loud instead of failing quiet, in the safe direction. But the flat claim "a stale, zero, negative, incomplete, or reverting feed all read as not yet, never as a release" was written before this case was found, and it did not hold for a future-dated timestamp.

The fix, a `updatedAt > block.timestamp` rejection, is written and tested but not deployed: PolicyVault is immutable, so it lands with the next vault deployment. Until then the deployed behaviour is as described here.

## Scheduling

PolicyVault v3 adds recurring policies: payroll, a fixed slice each interval, and sweep, the balance above a buffer. They release period by period through `releasePeriod`, and each period is a separate `PolicyReleased` that settles on its own.

Payroll, policy 2 on v3: 0.01 USDC every 4 seconds, three periods, then it retires.

| Period | Release | Payout |
| --- | --- | --- |
| 1 | [0xab3ca192...77d1b92](https://testnet.arcscan.app/tx/0xab3ca192218daa03580edfc56f82382eef7218e7433a84dda03d39fc377d1b92) | [0x0999a9e4...188ff9de](https://testnet.arcscan.app/tx/0x0999a9e408b163aec2619da681962923e95226d572c570f9b43a39a6188ff9de) |
| 2 | [0x9d879832...448f5265](https://testnet.arcscan.app/tx/0x9d87983254cb3433db6eebdd969d4ede15e1b70a519ae5332206c39b448f5265) | [0x22feb1de...70f176f0](https://testnet.arcscan.app/tx/0x22feb1dedbc70ab8c4965f3172957f0076100edabcbc385d14a17ebd70f176f0) |
| 3 | [0x0a0a625b...f874099e](https://testnet.arcscan.app/tx/0x0a0a625b64727604356386b80dfe5b715a2a01c19fef20858a3082bbf874099e) | [0xdc97a869...597f9650](https://testnet.arcscan.app/tx/0xdc97a869aabc7e6fd2c27d91d5cca798f6f143f359e7204613a497c6597f9650) |

Created in [0x7fedbc8b...4e5d9f9f](https://testnet.arcscan.app/tx/0x7fedbc8b6ca9cd50909bf65d94da391615ec5cb20b0294e388017cce4e5d9f9f). Each period is settled independently, keyed by policy id and period index, so the second and third periods are not mistaken for an already-settled first. Status after the third period: Executed.

Catch-up is bounded and safe. A period overdue beyond the policy's `maxCatchUp` is not paid automatically. On policy 3, the keeper's `releasePeriod` on the overdue period reverts, and only the owner can clear it:

| Step | Tx | Why |
| --- | --- | --- |
| keeper attempt | [0xc0468665...43c67d817](https://testnet.arcscan.app/tx/0xc046866520b8a026ed6105b18cec72f806229546ee61f3280c094bd43c67d817) | period overdue beyond maxCatchUp, `releasePeriod` reverts CatchUpStale |
| owner approval | [0x74aa639d...83a75e76](https://testnet.arcscan.app/tx/0x74aa639d7174a8de1e8061eef36665e5a7dc287711d62f80b255c3bb83a75e76) | `approveStalePeriod` releases exactly the held period |

This is the treasury-safe default: a schedule forgotten for two months does not auto-pay the day someone finally runs the keeper. The overdue period holds, and the owner decides.

### Sweep, policy 5 on v3

The other recurring shape. A sweep policy keeps a `buffer` and, on schedule, releases the balance above it to the recipient, skipping when the excess is below `minSweep`. Unlike payroll it does not retire: it stays active for top-ups. Policy 5 keeps a 0.05 USDC buffer and sweeps the excess every 4 seconds, with a 0.02 USDC dust floor.

| Step | Tx | Result |
| --- | --- | --- |
| create | [0x1e6d2a99...b7960d6](https://testnet.arcscan.app/tx/0x1e6d2a990e50ce55918baefa6d161dfe567aa1a1c1ed6f20a1fe1889cb7960d6) | sweep policy 5, keep 0.05 USDC, sweep the rest every 4s |
| sweep 1 | [0x838728c3...85e4cb0](https://testnet.arcscan.app/tx/0x838728c357d6d431cde3ff8d25cd4bcee2bd8d7aedac9e0be7f984f6b85e4cb0) | funded 0.15, released the **0.100000 USDC** excess, buffer kept. Payout [0x810c418b...8b1a1cf](https://testnet.arcscan.app/tx/0x810c418ba4a5f943a645d5e315f7288fb957f156bd773bc347f3bb1d38b1a1cf) |
| dust floor | [0x8a86c461...34bee92](https://testnet.arcscan.app/tx/0x8a86c461db01d0666d0f0024db62e50d5d86f5fe7e62c34eb395cbb0b34bee92) | only the buffer left, the due period **reverted SweepBelowMin, status 0**. Funded stayed at 0.05, not swept to zero |
| sweep 2 | [0xd64550e7...8b6758e](https://testnet.arcscan.app/tx/0xd64550e7fdb1ff09cf86b3da5fb5780235d19886e50581b1b6989548a8b6758e) | after a 0.08 top-up, released the **0.080000 USDC** excess. Payout [0xc1680f9f...ccd383e](https://testnet.arcscan.app/tx/0xc1680f9f21994756b1c9306c2dd0afcffccb040eb108a1230fa504fdcccd383e) |

Two things are proven past the happy path. The dust floor holds the buffer onchain: the refused sweep is a real status-0 receipt, and `funded` read back at 0.05 USDC, the buffer untouched rather than swept to zero. And the policy stays live after a sweep, so the 0.08 top-up swept again on the next period. Each sweep is a separate `PolicyReleased` that settles independently by `policyId:periodIndex`, exactly like payroll. `npm run demo:sweep` reproduces it.

## Gateway

A treasury can fund an Arc policy from a unified USDC balance sourced on another chain, with no manual bridge. This is Circle Gateway (Phase 2.2, Integration 1): the vault and its lock are unchanged, Gateway sits upstream on the funding side. Proven end to end at faucet scale.

USDC deposited on Base Sepolia, minted onto Arc, then a policy funded with it and settled to the recipient:

| Step | Tx | Note |
| --- | --- | --- |
| deposit (Base Sepolia) | [0x49ab8707...d54e6aad](https://sepolia.basescan.org/tx/0x49ab8707476c5dc1f14be8a8f4f61a4f48a1b553c1bd9ea394596209d54e6aad) | approve + deposit into the unified balance (deposit path) |
| gateway mint (Arc) | [0xf14ea2fb...00c467a5](https://testnet.arcscan.app/tx/0xf14ea2fbfbb513eda01a6663a3c5963d518c851fdf152cb158c19f0500c467a5) | USDC minted on Arc from the Base Sepolia balance |
| create + fund | [0xfffc3bac...073b3df3](https://testnet.arcscan.app/tx/0xfffc3bacd7affb64a48d174e82e272ef021064b047faf226419693ce073b3df3) | policy 4 on v3, funded from the Gateway-sourced USDC |
| release | [0xefe0027e...086a6062](https://testnet.arcscan.app/tx/0xefe0027e8612b63773d2908ee05c0dc4def33e859e53708356e686cf086a6062) | condition met |
| payout | [0xd03b0564...a2ca276b](https://testnet.arcscan.app/tx/0xd03b0564410ceea2703393132267c9bb1bc36ea1a712accf102edb8ca2ca276b) | recipient paid |

The funding hazard is engineered out, not just warned against: a bare ERC-20 transfer to the GatewayWallet loses the USDC, so its address lives in exactly one file, USDC only ever enters through deposit(), and a test enforces both. The spend delegate is a dedicated key that never doubles as the deployer. See docs/specs and the internal verification record.

## Failure paths

Two distinct failures are demonstrated, because a payment system that only proves the happy path has proved nothing.

### Condition not met, refused onchain

Policy 3, a timelock with a release time 24 hours out, release attempted immediately.

| Item | Value |
| --- | --- |
| Create | [0x75149f9b...4e0ee86baa7e](https://testnet.arcscan.app/tx/0x75149f9b5c27b27a99652cf7580e5f0679be34764316a067f59a4e0ee86baa7e) |
| `checkCondition(3)` | false |
| Premature release | [0x26e1acf0...3826664019ee](https://testnet.arcscan.app/tx/0x26e1acf092070b3f3731662aeb2c549d0bff50daee3a102ad6cf3826664019ee) |
| Result | **reverted**, status 0, 31,444 gas consumed |

The contract refused to move funds whose condition was not satisfied, and it refused onchain where anyone can verify it.

This transaction is signed by a raw EOA rather than a Circle wallet, deliberately. Circle developer-controlled wallets simulate before broadcasting and refuse to submit a transaction that would revert, failing with `ESTIMATION_ERROR` and producing no hash at all. Correct behaviour for a payments product, and incompatible with evidencing a revert. Forcing an explicit gas limit skips estimation and puts the failing transaction on chain.

### Leg succeeded, recording failed

Found during development, fixed, and covered by tests. A bridge completed onchain while persisting its result threw on a BigInt. The settlement was left `in_progress` with the leg marked pending, one resume away from bridging a second time.

The engine now distinguishes a leg that failed to execute from a leg that executed and failed to record. The first is retried; the second halts the settlement and demands manual reconciliation, because retrying it would repeat a completed transfer.

## Verified by balance, not by log

A settlement record claiming success is not proof. Balances read from chain before and after this run:

| Recipient | Chain | Delivered | Native gas held |
| --- | --- | --- | --- |
| attestation recipient | Arc | 0.500000 USDC (0.5 to 1.0) | n/a, gas is USDC |
| FX recipient | Arc | 0.377398 EURC | n/a, gas is USDC |
| cross-chain recipient | Base Sepolia | **0.606602 USDC** for a 0.5 policy | **0 ETH** |

The cross-chain recipient received **more** than the policy amount, not less, so the gross-up did its job. And that wallet **has never held a single wei of ETH** and was paid anyway, because Circle's forwarder submitted the mint. A recipient on a conventional chain does not need that chain's gas token to be paid.

## Costs and timings

| Measure | Value |
| --- | --- |
| Attestation settlement, signed release to paid | 6.8 s |
| FX settlement, release to paid | 16.6 s |
| Cross-chain settlement, release to paid | 28.8 s |
| PolicyVault v2 deployment | 0.0592 USDC |
| Cross-chain forwarder fee | 0.053301 USDC, flat |

### The forwarder fee is flat, not proportional

Measured with `estimateBridge` across five amounts on the same route:

| Amount bridged | Fee | As a percentage |
| --- | --- | --- |
| 0.50 USDC | ~0.0533 | 10.6% |
| 1.00 USDC | ~0.0533 | 5.3% |
| 10.00 USDC | ~0.0533 | 0.53% |
| 100.00 USDC | ~0.0533 | 0.053% |
| 1000.00 USDC | ~0.0533 | 0.005% |

A fixed relay cost, not a percentage fee. The canary's 0.50 USDC test amounts make it look punitive; at treasury-sized amounts it is negligible.

### The recipient never receives less than the policy amount

The forwarder fee is deducted from the minted amount, and the mint lands directly on the recipient, so there is no later step to correct a shortfall. The executor grosses up the burn: it burns the policy amount plus an allowance sized above the quoted fee, from its own working balance, so the recipient receives at least the policy amount. Policy 2's record:

| Field | Value |
| --- | --- |
| policy amount | 0.500000 |
| fee quote | 0.053301 |
| allowance burned on top | 0.159903 |
| actual fee charged | 0.053301 |
| **delivered to recipient** | **0.606602** |
| divergence flagged | no |

The recipient received more than the policy amount because the allowance exceeded the actual fee, which is the safe direction: nobody is short-changed. On treasury-sized transfers the fixed allowance is a rounding error; on these 0.50 test amounts it is visible overpay. Every settlement records quote against actual so the multiplier can be tightened from data.

## Reproducing

```
git submodule update --init   # OpenZeppelin
npm install
npm test                      # 210 tests: Foundry contract suite and executor suite

npm run wallets:write         # create the Circle developer-controlled wallets
npm run deploy                # deploy PolicyVault to Arc testnet
npm run canary                # FX and cross-chain archetypes
npm run demo:attestation      # release on a signed attestation
npm run demo:oracle           # depeg-protection release on live Pyth data
npm run demo:scheduling       # recurring payroll and the stale-hold path
npm run demo:sweep            # sweep the excess above a buffer, with the dust floor
npm run demo:gateway          # fund an Arc policy from USDC on Base Sepolia
npm run failure-path          # the onchain revert when a condition is unmet
npm run dashboard             # read-only monitor of policies and settlements
```

Requires a filled `.env`, see `.env.example`. Testnet only.
