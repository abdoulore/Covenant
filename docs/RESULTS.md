# RESULTS.md

Onchain proof for every claim this project makes. Each entry carries a transaction hash and an explorer link. Nothing is listed that has not actually executed.

Network: Arc Testnet (chain id 5042002) and Base Sepolia (84532). Testnet only.
Run date: 2026-07-23. Reproduce with `npm run canary`.

---

## What was proven

A payment that releases only when an onchain condition is met, then routes itself to the recipient across currencies and chains, with no human in the loop after the trigger, and refuses to move when the condition is unmet.

| Claim | Evidence |
| --- | --- |
| Conditional release enforced onchain | policy 10 and 11 releases, below |
| Release refused when condition unmet | reverted transaction, status 0, below |
| Automatic FX settlement | 0.50 USDC to 0.377028 EURC, paid to recipient |
| Automatic cross-chain settlement | Arc to Base Sepolia via CCTP, paid to recipient |
| Recipient needs no gas token | Base Sepolia recipient paid holding 0 ETH |
| No double payment on restart | claim-before-work store, 58 executor tests |

## Deployment

| Item | Value |
| --- | --- |
| Contract | PolicyVault |
| Address | [0x248391FE29318301a8CD957d28E58b7502387A22](https://testnet.arcscan.app/address/0x248391FE29318301a8CD957d28E58b7502387A22) |
| Deploy tx | [0xfd20eecf...2ae39e8](https://testnet.arcscan.app/tx/0xfd20eecf03e96b130dc337dcc73aa7ed533f55abe369da38588ee75962ae39e8) |
| Bytecode | 5,808 bytes |
| Cost | **0.0742 USDC** |

Constructor state read back from chain after deploy: `usdc()` is the 6 decimal ERC-20 view, `executor()` and `owner()` are the intended wallets, `nextPolicyId()` was 0.

Deployment cost is denominated in dollars because USDC is the native gas token on Arc. Deploying a treasury contract cost seven cents, known at the moment of deployment rather than exposed to a separate volatile asset.

## The canary

`npm run canary` stages two policies and then settles them by watching the chain. Nothing tells the executor what to do: it discovers work by scanning for `PolicyReleased`, exactly as it would if the policies had been created by someone else.

Two archetypes rather than one combined flow because EURC has no cross-chain route. CCTP and App Kit Bridge carry USDC only, and Arc is the sole swap-enabled testnet, so a single settlement delivering EURC to another chain is not buildable today. See DECISIONS.md D1.

### Policy 12, FX archetype, entirely on Arc

0.50 USDC released against a 1-of-1 approval condition, paid to the recipient in EURC.

| Step | Transaction | Note |
| --- | --- | --- |
| release | [0x82cab2ab...577c3e18](https://testnet.arcscan.app/tx/0x82cab2ab326af340abbd4d5d5ef5d4d0034e69f25a948943b6901d4c577c3e18) | condition met, funds to executor |
| fx | [0x40ed7205...adbf0c65](https://testnet.arcscan.app/tx/0x40ed7205957dff8891800c2fc2641e2d10765d630a3bc061436970a6adbf0c65) | 0.50 USDC to 0.401787 EURC |
| payout | [0xee5559e3...b59b7de5](https://testnet.arcscan.app/tx/0xee5559e3c4f2232a6167732009816ae56f5b1c4b966e9686bc5b10a0b59b7de5) | EURC to recipient |

**Settled in 13.7 seconds**, release to recipient paid.

### Policy 13, cross-chain archetype, Arc to Base Sepolia

0.50 USDC released against a 1-of-1 approval condition, paid to the recipient on Base Sepolia. The burn is grossed up so the recipient receives at least the policy amount after the forwarder fee, see the gross-up section below.

| Step | Transaction | Note |
| --- | --- | --- |
| release | [0x868cc758...4f5d865d](https://testnet.arcscan.app/tx/0x868cc758453a38aaccb702f5671a525b936737482b838fad3109948b4f5d865d) | condition met, funds to executor |
| bridge | [0x9c0deca1...81a3d1e9](https://sepolia.basescan.org/tx/0x9c0deca158c4791d1939a29cdff48f29015ab376d2a821b5defc700f81a3d1e9) | CCTP burn on Arc, mint to recipient on Base Sepolia |

**Settled in 38.4 seconds.** One transaction, not two: the mint lands directly on the recipient, so it is the payout. See DECISIONS.md D7.

### Verified by balance, not by log

A settlement record claiming success is not proof. The cross-chain recipient's balance, read from chain before and after policy 13:

| Recipient | Chain | Delivered by policy 13 | Native gas held |
| --- | --- | --- | --- |
| 0x2719a808...67b6eabb | Base Sepolia | **0.746478 USDC** for a 0.500000 policy | **0 ETH** |

Two things this proves. The recipient received **more** than the policy amount, not less, so the gross-up did its job: the promise "recipient receives at least the amount" held onchain. And the wallet **has never held a single wei of ETH** and was paid anyway, because Circle's forwarder submitted the mint. A recipient on a conventional chain does not need that chain's gas token to be paid.

## Failure paths

Two distinct failures are demonstrated, because a payment system that only proves the happy path has proved nothing.

### Condition not met, refused onchain

Policy 1, timelock with a release time 24 hours out, release attempted immediately.

| Item | Value |
| --- | --- |
| `checkCondition(1)` | false |
| Premature release | [0x815e2680...ecb51ae3](https://testnet.arcscan.app/tx/0x815e2680d0181b0e994f5d8a4087f197466497d1b7f9acc279ecd76decb51ae3) |
| Result | **reverted**, status 0, 31,496 gas consumed |

The contract refused to move funds whose condition was not satisfied, and it refused onchain where anyone can verify it.

This transaction is signed by a raw EOA rather than a Circle wallet, deliberately. Circle developer-controlled wallets simulate before broadcasting and refuse to submit a transaction that would revert, failing with `ESTIMATION_ERROR` and producing no hash at all. Correct behaviour for a payments product, and incompatible with evidencing a revert. Forcing an explicit gas limit skips estimation and puts the failing transaction on chain. See VERIFICATIONS.md V14.

### Leg succeeded, recording failed

Found during development, fixed, and covered by tests. A bridge completed onchain while persisting its result threw on a BigInt. The settlement was left `in_progress` with the leg marked pending, one resume away from bridging a second time.

The engine now distinguishes a leg that failed to execute from a leg that executed and failed to record. The first is retried; the second halts the settlement and demands manual reconciliation, because retrying it would repeat a completed transfer.

## Costs and timings

| Measure | Value |
| --- | --- |
| Same-chain FX settlement, release to paid | 16.2 s |
| Cross-chain settlement, release to paid | 27.8 s |
| Individual Arc transaction | ~3 s including Circle API round trip |
| PolicyVault deployment | 0.0742 USDC |
| FX leg, gas only | 0.017309 USDC |
| Payout leg, gas only | 0.001904 USDC |
| Cross-chain forwarder fee | 0.053247 USDC, flat |

### The forwarder fee is flat, not proportional

Measured with `estimateBridge` across five amounts on the same route:

| Amount bridged | Fee | As a percentage |
| --- | --- | --- |
| 0.50 USDC | 0.053245 | 10.649% |
| 1.00 USDC | 0.053247 | 5.325% |
| 10.00 USDC | 0.053247 | 0.532% |
| 100.00 USDC | 0.053247 | 0.053% |
| 1000.00 USDC | 0.053247 | 0.005% |

A fixed relay cost, not a percentage fee. The canary's 0.50 USDC test amounts make it look punitive; at treasury-sized amounts it is negligible. Recorded because reading the first row alone would badly mislead.

### Resolved: the recipient never receives less than the policy amount

An earlier run paid the cross-chain recipient 0.399847 against a 0.500000 policy, because the forwarder fee was deducted from the mint and the mint went straight to the recipient with no later step to correct it.

The fix, now implemented, grosses up the burn: the executor burns the policy amount plus an allowance sized above the quoted fee, from its own working balance, so the recipient receives at least the policy amount. Policy 13's record:

| Field | Value |
| --- | --- |
| policy amount | 0.500000 |
| fee quote | 0.099902 |
| allowance burned on top | 0.299706 |
| actual fee charged | 0.053228 |
| **delivered to recipient** | **0.746478** |
| divergence flagged | no |

The recipient received more than the policy amount because the allowance exceeded the actual fee, which is the safe direction: nobody is short-changed. The quote is a noisy predictor, seen at 0.053 with a 0.100 actual on one run and 0.100 with a 0.053 actual here, so the allowance is deliberately generous. On treasury-sized transfers the fixed ~0.30 allowance is a rounding error; on these 0.50 test amounts it is visible overpay. Every settlement records quote against actual so the multiplier can be tightened from data. See DECISIONS.md D6 and D7.

## Reproducing

```
npm run wallets:write   # create the developer-controlled wallets
npm run deploy          # deploy PolicyVault to Arc testnet
npm run canary          # stage and settle both archetypes
npm run failure-path    # demonstrate the onchain revert
```

Requires a filled `.env`, see `.env.example`. Testnet only.
