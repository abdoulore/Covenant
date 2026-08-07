# RESULTS.md

Onchain proof for every claim this project makes. Each entry carries a transaction hash and an explorer link. Nothing is listed that has not actually executed.

Network: Arc Testnet (chain id 5042002) and Base Sepolia (84532). Testnet only.
Run dates: 2026-07-27 (v2) and 2026-08-05 (v3). The four condition types and the Pyth oracle are proven on PolicyVault v2 at [`0xB702...09D1`](https://testnet.arcscan.app/address/0xB702404EA947aec698323Cd42989CA6168f209D1). Recurring and sweep scheduling are proven on its successor v3 at [`0xDC00...7300`](https://testnet.arcscan.app/address/0xDC0040eB02c438D59838A6f178e38184eACf7300). Two deployments, because the vault is immutable and scheduling changed it; nothing migrates and v2 keeps working.

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

## Deployment

| Item | Value |
| --- | --- |
| Contract | PolicyVault v2 (four condition types) |
| Address | [0xB702404EA947aec698323Cd42989CA6168f209D1](https://testnet.arcscan.app/address/0xB702404EA947aec698323Cd42989CA6168f209D1) |
| Deploy tx | [0x63b793fa...1d03b62475e](https://testnet.arcscan.app/tx/0x63b793fa52f9809e5a62832be635d537e3e20ae07a6ed2595d6cb1d03b62475e) |
| Cost | **0.0592 USDC** |

Deployment cost is denominated in dollars because USDC is the native gas token on Arc. Deploying a treasury contract with four condition types cost six cents, known at the moment of deployment rather than exposed to a separate volatile asset.

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

The fourth condition type releases when a price feed crosses a threshold, and it is proven onchain against a live Pyth feed. The condition reads a Chainlink-style `AggregatorV3Interface` and is fail-closed: 21 contract tests cover stale, zero, negative, incomplete, and reverting feed data, all read as "not releasable."

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

One current limitation, stated plainly: v1 checks the price against the threshold through the official Pyth adapter; confidence-interval rejection is designed and lands with the generic adapter, which the `AggregatorV3Interface` surface does not expose. See docs/specs for that design.

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
npm run demo:gateway          # fund an Arc policy from USDC on Base Sepolia
npm run failure-path          # the onchain revert when a condition is unmet
npm run dashboard             # read-only monitor of policies and settlements
```

Requires a filled `.env`, see `.env.example`. Testnet only.
