# FRONTEND_PROOF.md

Evidence that the user-facing surface works, the way RESULTS.md is evidence that the onchain
engine works. Onchain hashes do not prove a UI renders, so this file records the checks that do.

Grows in parts, matching the build: Part A (landing) is proven here now. Part B (the product app)
adds its end-to-end sections when it lands.

Network: Arc Testnet (chain id 5042002) and Base Sepolia (84532). Testnet only.

---

## Part A: Landing page

`site/index.html`, a single self-contained file. No keys, no backend, no build step. The only
network call is a client-side read of Pyth's public Hermes endpoint for the live depeg strip.
Verified 2026-08-08.

### Every claim links to a real transaction

The landing links six condition types and one cross-chain receipt to onchain proof. Each hash was
read back from chain with `cast receipt <hash> status`, not trusted from a log.

| Where on the page | Transaction | Chain | Onchain status |
| --- | --- | --- | --- |
| Timelock, "refused early, status 0" | [0x26e1acf0](https://testnet.arcscan.app/tx/0x26e1acf092070b3f3731662aeb2c549d0bff50daee3a102ad6cf3826664019ee) | Arc | **false** (the refusal, as labeled) |
| Approval, release | [0xd5a5008b](https://testnet.arcscan.app/tx/0xd5a5008b280fcfbe8d2713fc0f4383eadbfadbc038cec4fe504e77d4a08c27c9) | Arc | true |
| Attestation, attest | [0xaa1e518a](https://testnet.arcscan.app/tx/0xaa1e518abc7cb2109b381f76735312ba92b63182a9d89d25a0460f0d438e5659) | Arc | true |
| Oracle, release on live Pyth | [0x02173d2f](https://testnet.arcscan.app/tx/0x02173d2f68f74800ad3fe7132815d4b09a6bd0a9b5de0bfaf69e6ea1a3ff80d3) | Arc | true |
| Recurring, payroll period 1 | [0xab3ca192](https://testnet.arcscan.app/tx/0xab3ca192218daa03580edfc56f82382eef7218e7433a84dda03d39fc377d1b92) | Arc | true |
| Sweep, release the excess | [0x838728c3](https://testnet.arcscan.app/tx/0x838728c357d6d431cde3ff8d25cd4bcee2bd8d7aedac9e0be7f984f6b85e4cb0) | Arc | true |
| Receipt, funds left vault | [0xf2ef10c2](https://testnet.arcscan.app/tx/0xf2ef10c2dd7a15cd4f69e0cf6689e3eb175b632cafbae7b750f85c6131bcee59) | Arc | true |
| Receipt, recipient paid | [0x68263cfc](https://sepolia.basescan.org/tx/0x68263cfcf2f38df680b769a65697cab9b3677f3cabba1b21ae28f020253844fe) | Base Sepolia | true |

The timelock link is a status-0 receipt on purpose: it is the transaction where the contract
refused an early release, which is what the page says it is. Every figure in the numbers block
traces to docs/RESULTS.md.

### The live depeg strip works browser-direct

The strip reads Pyth's Hermes endpoint from the browser, so the page needs no backend. Hermes
allows it: both the GET and the OPTIONS preflight return `access-control-allow-origin: *`.

Loaded in a real browser, the strip rendered a live price (for example `0.999871` USDC/USD with a
`0.000548` confidence band), the peg verdict, and an "updated Ns ago" tick that advances between
fetches. It refetches every 20 seconds. No console errors on load.

### The degraded path is honest, not an error

Forcing the Hermes fetch to fail (overriding `fetch` to reject, then calling the loader) replaces
the strip with a static panel that states the release rule (`price >= 0.995`) and links the
onchain oracle release, and points to the live monitor. Verified in-browser:

| Property | Result |
| --- | --- |
| Fallback panel shown | yes |
| Release rule shown | yes |
| Onchain proof link shown | yes (`0x02173d2f`) |
| A fabricated price shown | **no** |
| Monitor hint shown | yes (`npm run dashboard`) |

The page never shows an invented number and never a bare error, exactly the plan's requirement.

### Viewport and accessibility

At a 375px mobile viewport the page has no horizontal overflow (`document.documentElement.scrollWidth`
equals `window.innerWidth`, both 375), and all six condition rows render. The layout reuses the
monitor's tokens, which pass WCAG AA for text on the off-black background; the single accent is
`--live` and status colors are functional. Links are native anchors, so the page is keyboard
reachable.

### No secrets in the artifact

The landing is a static file with no credentials of any kind. Nothing to leak, confirmed by
reading the file: no keys, tokens, or wallet material.

### Reproduce these checks

- Open `site/index.html` in a browser. The depeg strip should show a live USDC/USD price.
- Verify any linked transaction: `cast receipt <hash> status --rpc-url <arc-or-base-rpc>`.
- Confirm Hermes CORS: `curl -sI -H "Origin: https://x" "https://hermes.pyth.network/v2/updates/price/latest?ids[]=0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a&parsed=true"` shows `access-control-allow-origin: *`.
- Degraded path: with the page open, in the console override `window.fetch` to reject and call
  `loadPrice()`; the strip becomes the static rule-and-proof panel with no number.

### Pending

- Full-page screenshots at laptop and mobile widths, captured once the page is deployed to a real
  host (hosting is an open judgment call). The DOM-level evidence above stands in until then.
