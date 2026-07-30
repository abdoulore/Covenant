# RESULTS.md

Onchain proof for every claim this project makes. Each entry carries a transaction hash and an explorer link. Nothing is listed that has not actually executed.

Network: Arc Testnet (chain id 5042002) and Base Sepolia (84532). Testnet only.
Run date: 2026-07-27. Every proof below is on one contract, PolicyVault v2 at [`0xB702404EA947aec698323Cd42989CA6168f209D1`](https://testnet.arcscan.app/address/0xB702404EA947aec698323Cd42989CA6168f209D1).

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
| No double payment on restart | claim-before-work store, 85 executor tests |

## The four condition types

A policy releases when its condition is met. PolicyVault enforces all four onchain:

- **Timelock**: releasable after a timestamp. Demonstrated in the failure path below.
- **Approval**: releasable after N-of-M named approvers call approve. Used by both canary policies.
- **Attestation**: releasable when a named attester signs an EIP-712 statement. Policy 0 below.
- **Oracle**: releasable when a Chainlink Data Feed crosses a threshold. Built and tested, not yet demoed onchain (see the Oracle section).

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

The fourth condition type, releasing when a Chainlink Data Feed crosses a threshold, is built and tested (21 contract tests, fail-closed on stale, zero, negative, incomplete, or reverting feed data) with an executor keeper that discovers oracle policies, polls, and calls release when the price crosses. Chainlink Automation is not available on Arc, which is why the keeper exists. The keeper is feed-agnostic and is proven against a mock aggregator in tests.

It is not demoed onchain, and the reason is a verified fact about Arc rather than a missing lookup. Arc testnet does not publish Chainlink push Data Feed addresses today: Chainlink's own `feeds-arc-testnet.json` returns 404, Arc does not appear in the Data Feeds address directory, and the Arc x Chainlink announcement presents Data Streams and CCIP as the live oracle surface. Data Streams is a pull-based model, where a signed report is fetched off-chain and verified on-chain, which reads differently from the on-chain `AggregatorV3Interface` this condition uses. A live oracle demo therefore waits on either Arc publishing push feeds or a Data Streams rework of the condition. The condition and keeper are correct for a push-feed chain; this is an infrastructure gap on Arc, not a defect. See docs/specs for the design.

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
npm test                      # 178 tests: Foundry contract suite and executor suite

npm run wallets:write         # create the Circle developer-controlled wallets
npm run deploy                # deploy PolicyVault to Arc testnet
npm run canary                # FX and cross-chain archetypes
npm run demo:attestation      # release on a signed attestation
npm run failure-path          # the onchain revert when a condition is unmet
```

Requires a filled `.env`, see `.env.example`. Testnet only.
