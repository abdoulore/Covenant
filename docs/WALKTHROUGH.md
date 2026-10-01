# Walkthrough

Covenant lets you lock USDC behind a condition (a date, an approval, a verifier's sign-off, a schedule) and have a contract pay the recipient the moment it is met, on Arc, Base or Arbitrum. If the condition is never met, the money goes back to whoever funded it. Nobody in between holds it.

It is live on Arc mainnet as an unaudited beta, capped at 100 USDC in total. If you have ten minutes, this is the tour.

## 1. The site (one minute)

Open [covenant-mainnet.vercel.app](https://covenant-mainnet.vercel.app). The panel at the top right is not a mock-up: your browser reads it straight from the vault on Arc mainnet, so it shows how much USDC the vault holds against its cap, and how many policies exist, right now.

## 2. The contract (two minutes)

The vault is [`0x6C2F006D6788883Cc6520DB80905079f2BBDB3f7`](https://explorer.arc.io/address/0x6C2F006D6788883Cc6520DB80905079f2BBDB3f7) on Arc mainnet. Its source is verified on Sourcify with an exact match, creation and runtime bytecode both: [repo.sourcify.dev/5042/0x6C2F006D6788883Cc6520DB80905079f2BBDB3f7](https://repo.sourcify.dev/5042/0x6C2F006D6788883Cc6520DB80905079f2BBDB3f7).

Three functions carry the whole idea, in [`contracts/src/PolicyVaultV5.sol`](../contracts/src/PolicyVaultV5.sol):

- **`release`** pays a policy whose condition holds. Anyone may call it; the condition is the only gate, and the money can only go to the recipient.
- **`cancel`** and **`reclaim`** return the money to the policy's owner: before the deadline while the condition is unmet, or after the deadline whatever was not paid.
- **`_send`** is where the vault pays: a USDC transfer on Arc, or a CCTP v2 burn with Circle's Forwarding Service for Base and Arbitrum.

There is no admin key and no upgrade. The guardian, a 2-of-3 Safe at [`0x75e204AfA5f390490f2d5021c92C1B5d38a9D52a`](https://explorer.arc.io/address/0x75e204AfA5f390490f2d5021c92C1B5d38a9D52a), can pause releases for up to a week and raise the funds cap. It cannot move anyone's money.

## 3. A payment that crossed chains (three minutes)

Policy 1 on the mainnet vault paid 0.10 USDC to a wallet on Base that held no ETH:

1. [Created and funded](https://explorer.arc.io/tx/0x6405787ef5a67948809ae9e19218cc0dc4b2c0448c971dac2b5a1c55c4e0e256) in one transaction from the owner's wallet. The owner also paid Circle's forwarding fee, 0.060339 USDC, fixed when the policy was created.
2. [Released on Arc](https://explorer.arc.io/tx/0xd691b51026dbd5d6c72f64348556413b0ce826933d7cca9a15ab7cd4ba6c7009). In that one transaction the vault burned the USDC through CCTP v2.
3. [Minted on Base](https://basescan.org/tx/0xc8fe7f99a509f50a827604d19f3ca252dfb283fab58b9bc52fdc5f896b2b1be7), 8 seconds later, by Circle's forwarder. The recipient did nothing and needed no gas: it simply received exactly 0.10 USDC.

Policy 0 is the same-chain case: [created](https://explorer.arc.io/tx/0x93c9a2e299d4c6ab37684d21f21dbc2a31af8339c216a28e71394c434be61c82), then [released](https://explorer.arc.io/tx/0x6242536b4b1be14621936bdc5d96c1af573f8305774dd2230c7d4f097dfae37b), with the vault transferring the USDC to the recipient inside the release transaction itself.

## 4. Try it yourself (four minutes)

With a browser wallet holding a little USDC on Arc mainnet:

1. Open [the app](https://covenant-mainnet.vercel.app/app/) and connect your wallet.
2. **New policy from your wallet** → *timelock*: your own second address as recipient, 0.10 USDC, paid on Arc, releasable in three minutes. The review shows exactly what leaves your wallet; you confirm one transaction.
3. When it is due, open the policy and press **Release**. Anyone could; the contract pays the recipient itself.

Or create one you then cancel, and watch the full amount come back.

## Where to go next

- [RESULTS.md](RESULTS.md): every transaction behind every claim, mainnet first, then the full testnet record.
- [The README](../README.md): what a policy can do, the guardian, and the beta's limits.
- [OPERATIONS.md](OPERATIONS.md): running the keeper and monitor, and deploying.
