# Contracts

The Solidity behind Covenant, built and tested with [Foundry](https://book.getfoundry.sh/).

## What is deployed where

| Contract | Network | Address | Role |
| --- | --- | --- | --- |
| **`src/PolicyVaultV5.sol`** | **Arc mainnet** | [`0x6C2F006D6788883Cc6520DB80905079f2BBDB3f7`](https://explorer.arc.io/address/0x6C2F006D6788883Cc6520DB80905079f2BBDB3f7) | **the product**: the non-custodial vault, live as an unaudited beta capped at 100 USDC |
| `src/PolicyVaultV5.sol` | Arc testnet | [`0x87A204d4eDbE715b00eA05a2Ad860f40b710c890`](https://testnet.arcscan.app/address/0x87A204d4eDbE715b00eA05a2Ad860f40b710c890) | the same contract, for its testnet re-proof |
| `src/PolicyVault.sol` | Arc testnet | [`0x3b507607bA48A65587a9a6136c36cd2f1132d498`](https://testnet.arcscan.app/address/0x3b507607bA48A65587a9a6136c36cd2f1132d498) | v4, the earlier operator-run vault, kept for its proofs |

Both v5 deployments are verified on Sourcify with an exact match. Every deployment, with its transactions, is in [docs/RESULTS.md](../docs/RESULTS.md).

## PolicyVaultV5

Each policy belongs to the wallet that funds it. It pays one recipient, on Arc or through CCTP v2 on another chain, once its condition holds and before its deadline; otherwise it goes back to the owner. There is no admin key and no upgrade path.

- **Conditions:** timelock, N-of-M approval, EIP-712 attestation by a named attester, Chainlink price feed, signed price proof through a pluggable adapter (`IOracleAdapter`), payroll, and sweep above a buffer.
- **Payouts:** a USDC transfer on Arc, or `depositForBurnWithHook` on Circle's TokenMessengerV2 with the Forwarding Service hook for the destinations fixed at deploy. The cross-chain fee is fixed per policy and paid by the owner.
- **Owner actions:** cancel an unmet policy before the deadline, stop a payroll (periods already owed stay payable), reclaim after the deadline, extend the deadline, top up, add to and raise the cross-chain fee.
- **Guardian:** pause releases for up to 7 days, with deadlines moving out by the time paused; raise the funds cap, never lower it; hand the role on, or give it up. It never touches funds.
- **Funding in one transaction:** `permitUsdc` and the vault's `multicall`, or Arc's Multicall3From, which the app uses.

## Layout

```
src/
  PolicyVaultV5.sol        the v5 vault
  PolicyVault.sol          v4, the testnet operator vault
  IOracleAdapter.sol       the seam for signed-price providers
  PythAdapter.sol          the Pyth implementation of it (testnet; Pyth is not on Arc mainnet)
  ITokenMessengerV2.sol    the slice of Circle's CCTP v2 the vault calls
  proof/                   instruments used only to prove behaviour onchain
  vendor/pyth/             Pyth's interfaces and AggregatorV3 wrapper, vendored
script/
  DeployPolicyVaultV5.s.sol  validates every setting before broadcasting; MAINNET_-prefixed settings on chain 5042
test/
  PolicyVaultV5.t.sol      52 tests of the v5 vault, plus the deploy script's own tests
  mocks/                   USDC with permit, CCTP messenger, price feeds, oracle adapter
```

## Build and test

```bash
git submodule update --init   # OpenZeppelin and forge-std
forge build
forge test
```

Foundry's local EVM is Ethereum's, not Arc's: Arc's runtime differences (USDC as gas, the USDC blocklist enforced at runtime, a 20 gwei minimum fee) are covered by the onchain proofs in RESULTS.md rather than by these tests.

Deploying, and everything else operational, is in [docs/OPERATIONS.md](../docs/OPERATIONS.md).
