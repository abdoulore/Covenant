# Vendored: Pyth Network Solidity SDK (subset)

These four files are copied unmodified from the official Pyth SDK
(`pyth-network/pyth-crosschain`, `target_chains/ethereum/sdk/solidity`), Apache-2.0.
Fetched 2026-07-31.

Vendored rather than pulled as a Foundry lib because Covenant needs only the
AggregatorV3 wrapper and its interface. `forge-std` and OpenZeppelin already set the
precedent for a small, pinned dependency under this package.

- `PythStructs.sol`      price structs (`price`, `conf`, `expo`, `publishTime`)
- `IPythEvents.sol`      events
- `IPyth.sol`            the Pyth contract interface
- `PythAggregatorV3.sol` the official Chainlink-`AggregatorV3Interface` adapter over one Pyth feed

Used by Option 1 of the internal Pyth adapter spec: deploy one
`PythAggregatorV3(pyth, feedId)` per feed and point a PolicyVault oracle policy's
`feed` at it, so the existing, tested Oracle condition reads a live Pyth price with no
vault change. Pyth on Arc testnet: `0x2880aB155794e7179c9eE2e38200202908C17B43`.

The wrapper reads `getPriceUnsafe`, so it does not revert on a stale price; freshness is
enforced by PolicyVault's own `maxStaleSeconds` staleness check, which reads the Pyth
`publishTime` the wrapper returns as `updatedAt`.
