# Walkthrough

Covenant is a programmable treasury engine on Arc. A business locks USDC in an onchain vault with a policy: pay recipient R amount A in currency C on chain D, but only when condition X is met. The moment the condition is met, settlement runs itself across an FX leg and a cross-chain leg. The contract decides whether the money moves; the offchain service only decides how it routes. Everything below is on live testnet, and every number traces to a transaction hash in [RESULTS.md](RESULTS.md).

If you have ten minutes, look at these two things.

## 1. A policy that releases on live oracle data

This is the product's core claim made concrete: the contract, not a server, decides whether a payment fires, and it decides on data anyone can verify.

The policy is USDC/USD depeg protection. It releases only while USDC holds its peg, checked against a live Pyth price feed, on the same vault as every other proof. Arc testnet publishes no Chainlink push feeds, so the oracle runs on Pyth, a pull oracle deployed on Arc and reachable with no credentials. Pyth's official PythAggregatorV3 adapter exposes the price through the same `AggregatorV3Interface` the condition already reads, so the vault did not change and did not redeploy.

Where to look:

- **The onchain run**, in [RESULTS.md](RESULTS.md) under Oracle: create, a keyless price update (fee 1 wei of native USDC), release, payout, settled in 9.0 seconds. Both failure paths are proven in the same section: a "release only if USDC/USD below 0.99" depeg policy held unmet by a healthy live price, and a stale-price policy refused by the fail-closed staleness guard. Each reverts onchain with status 0.
- **The live panel**: run `npm run dashboard` and read the top panel. It plots the current Pyth USDC/USD price on a gauge against the 0.995 peg floor and the 0.990 depeg trigger, with the release verdict. Real data, updating live.

## 2. A settlement receipt with the measured custody gap

The second artifact is the full multi-step settlement, and it is honest about the one trust window it has.

A policy releases 0.5 USDC on Arc and pays a recipient on Base Sepolia. The executor burns through CCTP v2, and Circle's forwarder mints directly to the recipient, so the recipient needs no gas token on the destination chain. That recipient wallet has never held a single wei of ETH and was paid anyway.

Where to look:

- **The onchain run**, in [RESULTS.md](RESULTS.md) under The canary, Policy 2: release on Arc, then a CCTP burn-and-mint that lands directly on the recipient, settled in 28.8 seconds. Verified by reading the recipient's balance from chain, not from a log: 0.606602 USDC delivered for a 0.5 policy, holding 0 ETH.
- **The dashboard receipts**: each settlement is shown as funds left the vault at T1, recipient paid at T2, executor held for N seconds. The cross-chain receipt is tagged, so its larger gap is read correctly: it includes bridge attestation time, not just executor custody.

Two things a careful reviewer will check, both answered:

- **The recipient is never short-changed.** The forwarder fee is deducted from the mint, so the executor grosses up the burn from its own balance. The recipient received more than the policy amount, never less. The fee is flat (0.053301 USDC), not proportional, so at treasury size it is a rounding error.
- **The custody gap is measured, not hidden.** The vault releases to the executor wallet, which holds the funds for the seconds between release and payout. That window is timestamped on every settlement and shown in the dashboard, rather than glossed over.

## If you have one minute

Run `npm run dashboard`. The depeg panel shows a live oracle price driving a real release rule. The settlement receipts show real multi-leg payments with the custody gap measured per transaction. Every hash links to the explorer.

## Reproduce it

```bash
npm test              # 210 tests, contract and executor
npm run demo:oracle   # the depeg-protection release on live Pyth data
npm run canary        # the FX and cross-chain settlements
npm run dashboard     # the monitor with the depeg panel and the receipts
```

Requires Node 20 or newer, Foundry, and a filled `.env` (copy `.env.example`). Testnet only. Full transaction hashes and explorer links for every claim this project makes are in [RESULTS.md](RESULTS.md).
