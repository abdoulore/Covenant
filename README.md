# Covenant

Programmable treasury settlement on Arc. Lock USDC in an onchain vault, attach a rule for who gets paid, how much, in which currency, and on which chain, and the payment settles itself the moment the rule is met. Every step is verifiable onchain.

Built for the Circle brief on stablecoin-native DeFi on Arc. Testnet only.

## What it is

A treasury holder deposits USDC into a vault and creates a policy: pay recipient R an amount A, in currency C, on chain D, but only when condition X is met. The moment the condition is satisfied, settlement runs on its own. It converts the currency if it needs to, moves the funds across chains with CCTP, and pays the recipient. Nobody signs anything after the trigger.

The split that makes this safe: the contract decides whether the money moves, and enforces the condition onchain. The off-chain service only decides how the money routes. If the condition is not met, release reverts on Arc, and anyone can check that it did.

## How it works

```mermaid
flowchart TB
    T[Treasury wallet] -->|deposit USDC| V[PolicyVault on Arc]
    V -->|condition NOT met| X[release reverts, status 0]
    V -->|condition met, PolicyReleased| E[Executor service]

    E --> A{payout currency and chain}
    A -->|EURC on Arc| S[App Kit swap USDC to EURC]
    S --> PA[send EURC to recipient on Arc]
    A -->|USDC cross-chain| C[CCTP v2 burn on Arc]
    C --> PB[mint direct to recipient on Base Sepolia]
```

- **PolicyVault** (Solidity, Arc) holds the USDC and enforces the release condition. It supports a timelock and an N-of-M approval condition, and reverts if release is attempted before the condition holds.
- **Executor** (TypeScript) watches for the `PolicyReleased` event and routes the settlement. It never decides whether funds move, only how they get to the recipient. Settlement state is written before any funds move, so a restart never pays twice.
- **Wallets** are Circle developer-controlled wallets for the treasury, executor, and recipient roles, behind one interface so a later move to user-controlled wallets touches no settlement logic.

## Why this needs Arc

This is treasury logic that only stays simple when the stablecoin is the native asset.

- **USDC is native gas.** The vault deploys for about seven cents, priced in dollars, with no exposure to a separate volatile gas token.
- **Sub-second finality.** Settlement completes in seconds, not the days a conventional cross-border payment takes.
- **Native cross-chain USDC.** CCTP v2 burns and mints the real asset. No wrapped tokens and no third-party bridge.
- **Gasless recipient.** Circle's forwarder submits the mint, so the payee needs no gas token on the destination chain to be paid.

## Circle products used

| Product | Where it is used |
| --- | --- |
| USDC on Arc | Native gas token and the settlement asset. Amounts, fees, and deploy cost are all in dollars. |
| Circle Wallets | Developer-controlled treasury, executor, and recipient wallets, behind one interface. |
| App Kit | Swap for the FX leg, send for the payout, run server-side with idempotent settlement state. |
| CCTP v2 | Native cross-chain USDC by burn and mint, with a forwarder so the recipient needs no gas. |

## Proof

Everything is proven on live testnet. Full transaction hashes and explorer links are in [docs/RESULTS.md](docs/RESULTS.md).

| Result | Value |
| --- | --- |
| FX settlement on Arc, release to paid | 13.7 seconds |
| Cross-chain settlement, Arc to Base Sepolia | 38.4 seconds |
| PolicyVault deployment cost | 0.0742 USDC |
| Recipient paid on Base Sepolia | while holding zero ETH |
| Condition unmet | release reverts onchain, status 0 |
| Automated tests | 127, across contract and executor |

Deployed PolicyVault: [`0x248391FE29318301a8CD957d28E58b7502387A22`](https://testnet.arcscan.app/address/0x248391FE29318301a8CD957d28E58b7502387A22) on Arc Testnet (chain id 5042002).

## Repository layout

```
contracts/   Foundry package: PolicyVault, tests, deploy script
executor/    TypeScript service: event watcher, settlement engine, Circle integration
docs/        RESULTS.md, onchain proof for every claim
```

Code comments cite `docs/VERIFICATIONS.md` and `docs/DECISIONS.md`, the internal records of what was verified against Circle and Arc documentation and why each architectural call was made. Those are working documents and are not part of this repository. The findings that matter to the code are restated in the comments themselves, so nothing here depends on reading them.

## Running it

Prerequisites: Node 20 or newer, Foundry, and a filled `.env` (copy `.env.example`). Testnet only.

```bash
git submodule update --init # OpenZeppelin, required before the contracts will build
npm install                 # install executor dependencies
npm test                    # 127 tests: Foundry contract suite and executor suite

npm run wallets:write       # create the Circle developer-controlled wallets
npm run deploy              # deploy PolicyVault to Arc testnet
npm run canary             # stage and settle both archetypes end to end
npm run failure-path       # demonstrate the onchain revert when a condition is unmet
```

Fund the treasury and executor wallets from the Circle faucet at faucet.circle.com on Arc Testnet before running the canary. USDC is gas on Arc, so the executor needs a working balance on top of the settlement amounts.

## Status

Phase 1, the settlement canary, is complete: both payment archetypes settle end to end onchain, the failure path is proven, and the recipient is never short-changed. The system runs on testnet only.
