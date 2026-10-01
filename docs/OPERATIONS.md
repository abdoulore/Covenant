# Operations

How to run and deploy every part of Covenant. The [README](../README.md) describes the product; this
is the runbook.

Two stacks live in this repository:

- **v5, the product, on Arc mainnet:** the vault, the mainnet app, and the v5 keeper and monitor.
- **The testnet operator stack:** the v4 vault, the executor, the write API, the operator app and the
  read-only monitor. It is testnet only and kept for its proofs (see Testnet history in the README).

## The mainnet app

The mainnet app is the same code as the testnet app, built in Vite mode `mainnet`:

```bash
npm --prefix app run dev:mainnet     # locally
npm --prefix app run build:mainnet   # app/dist-mainnet, gated on the bundle secret check
```

It reads the vault directly from Arc mainnet, through every public RPC Arc lists and then the
connected wallet, and signs from the user's wallet. It needs no server. The vault address is pinned
in `app/src/v5/chain.ts`, and the executor suite checks it against the mainnet broadcast record.

It is deployed by its own Vercel project, `covenant-mainnet`: root directory `app`, build settings in
`app/vercel.json`, production branch **`mainnet`**. Work lands on `main`, which deploys the testnet
site; the mainnet site changes only when `mainnet` is moved forward to a tested commit:

```bash
git branch -f mainnet <tested commit> && git push origin mainnet
```

After a contract change, `node app/scripts/sync-v5-abi.mjs` refreshes the app's copy of the ABI; the
executor suite fails until it is run.

## Deploying the vault

`contracts/script/DeployPolicyVaultV5.s.sol` validates everything before broadcasting: 6-decimal USDC,
a CCTP messenger that serves every destination, a cap above zero, and on mainnet a guardian that is a
contract. On Arc mainnet (chain 5042) it reads only `MAINNET_`-prefixed settings from `.env`
(`MAINNET_DEPLOYER_PRIVATE_KEY`, `MAINNET_V5_GUARDIAN`, and so on), so no testnet value can be used
there. Always run it without `--broadcast` first.

## Running it

Prerequisites: Node 20 or newer, Foundry, and a filled `.env` (copy `.env.example`). Testnet only.

```bash
git submodule update --init # OpenZeppelin, required before the contracts will build
npm install                 # root and the executor workspace
npm --prefix app install    # the app is a separate package with its own lockfile
npm test                    # the Foundry contract suite and the executor suite

npm run wallets:write       # create the Circle developer-controlled wallets
npm run deploy              # deploy PolicyVault to Arc testnet
npm run canary              # stage and settle the FX and cross-chain archetypes
npm run demo:attestation    # release a policy on a signed attestation, end to end
npm run failure-path        # demonstrate the onchain revert when a condition is unmet
npm run dashboard           # read-only monitor: policies, settlement receipts, live depeg panel
```

The operator app, which creates, funds, approves, and releases policies through a gated API:

```bash
npm run api                 # the write API. Needs OPERATOR_SECRET; see .env.example
COVENANT_KEEPER=on npm run api  # the same, and also settle releases as they happen; needs DATABASE_URL
npm --prefix app run dev    # the operator app, proxying /api to the API above
npm --prefix app run build  # production bundle, gated on the bundle secret check
```

The keeper records every settlement in Postgres, keyed on the vault, the policy id, and the period, so the database itself refuses to pay the same release twice. Policy ids restart at zero on each vault deployment, so the vault has to be part of that key; without it, a policy on a new vault would look like one already paid. The keeper will not start without `DATABASE_URL`.

Payments that never happened are checked for too. The keeper keeps a ledger of every release the vault has emitted, from its deploy block, and every five minutes compares it with what was settled. A release left unpaid, a settlement stuck or failed, or the keeper falling behind the chain is sent to Telegram once, and again when it clears. The same check and the tools to act on it are commands:

```bash
npm run reconcile                              # every release that needs attention
npm run reconcile -- backfill                  # record the vault's release history into the ledger
npm run reconcile -- resolve <tx> --note "..." # record a release as paid another way
npm run settle-release -- <tx>                 # what paying a stranded release would do; --send to pay it
```

For v5, the keeper no longer pays anyone: the vault pays at release. It calls release when a policy can be released, simulating each call first so the contract decides, and the monitor alerts on a releasable policy nobody released, a deadline within a day, and a cross-chain mint Circle has not completed:

```bash
npm run v5:release             # release every v5 policy that can be; --watch to keep going
npm run v5:monitor             # one monitoring pass
```

In the app, v5 is used from the user's own browser wallet, separate from operator sign-in. A user creates and funds a policy in one transaction, which approves the exact amount and creates the policy together through Arc's Multicall3From, and signs every action as the role they hold: anyone can release a policy that is due; its approvers approve; its attester signs; only its owner can cancel, stop, reclaim, extend or add funds. The vault address is built into the app (`app/src/v5/chain.ts`), not taken from the API, so a server cannot redirect a user's money. After a contract change, run `node app/scripts/sync-v5-abi.mjs` to refresh the app's copy of the ABI; the executor suite fails until you do.

`settle-release` refuses a release the ledger has not seen, one recorded as paid another way, and one with any settlement already started, and pays through the same database claim as the keeper, so it cannot pay twice.

The API refuses to start in a deployed environment without an operator secret and a pinned CORS origin. For a local run set `COVENANT_ENV=dev`. The app talks only to the API: it holds no keys and no provider, and `npm --prefix app run build` fails if any secret material reaches the bundle.

Repo checks:

```bash
npm run typecheck           # both TypeScript packages
npm run test:count          # derive the test count and check the README against it
```

Fund the treasury and executor wallets from the Circle faucet at faucet.circle.com on Arc Testnet before running the canary. USDC is gas on Arc, so the executor needs a working balance on top of the settlement amounts.

## Deploying

Two halves with different requirements, and the split is not cosmetic.

| Piece | What it is | Where it can run |
| --- | --- | --- |
| landing page and operator app | one static bundle, page at `/` and app at `/app` | any static host |
| the write API | persistent Node process | a host that keeps a process alive |
| the monitor | persistent Node process, read-only | same |

`npm run build:web` produces the static half into `dist/`: the landing page at the root and the app under `/app`. They ship together on one host so the landing page links the app with a relative path. That is presentation only; the app's connection to the write API is cross-origin either way, because the API is not on that host.

The build refuses to assemble if the app bundle was compiled without the `/app/` base, since its assets would otherwise resolve to the root and return the landing page's HTML instead of JavaScript.

**The API must not run on serverless functions.** Two protections depend on state held in the process. Idempotency reserves an in-flight key so simultaneous duplicate writes collapse into one execution; login rate limiting counts attempts against the single operator secret. Split across instances, both silently stop working: two concurrent funds land on separate instances and both execute, and the brute-force ceiling becomes per-instance rather than global. Nothing errors. Run the API where one process handles all of it, or move both to shared storage first.

### Splitting the app and the API across origins

The static bundle and the API on different hosts is a cross-site pair, and three settings have to agree:

```bash
# on the app build
VITE_API_BASE=https://api.example.com   # absolute, or requests go to the app's own origin

# on the API
COVENANT_CORS_ORIGIN=https://app.example.com   # the app's exact origin, never a wildcard
OPERATOR_SECRET=...                            # required; the API refuses to start without it
```

The session cookie switches to `SameSite=None; Secure` automatically when a cross-origin deployment is detected, because a `SameSite=Strict` cookie is never sent cross-site and every write would fail as unauthenticated with nothing in the logs to explain it. That relaxation gives up the browser's own CSRF protection, so write routes then require an `Origin` header matching `COVENANT_CORS_ORIGIN`. Both changes are derived from one flag so they cannot drift apart.

If the app and API sit behind one origin through a proxy, set `COVENANT_SAME_ORIGIN=true` to keep the stricter cookie.

`APP_URL` at the top of the script block in `site/index.html` points at the app. It is `/app`, matching the assembled layout. Set it to `""` to hide the button; a landing page should show no link rather than a dead one.

### Vercel

`vercel.json` sets the build command and output directory. Keep the project's root directory at the repository root: the config and the assembly step both live there, and neither `site/` nor `app/` can produce the combined output on its own. Leave the build and output fields blank in the dashboard, since the file already sets them.

The one rewrite sends unmatched `/app/*` paths to the app's entry point. The app is a single page with no server routes, and static files under `/app` are served directly, so only paths with no file behind them fall through. Vercel's schema rejects unknown keys in that object, so the explanation lives here rather than beside it.

Set `VITE_API_BASE` as a build environment variable pointing at the deployed API, with no trailing slash, or the app will request `/api` from its own origin and find nothing there. It is baked into the bundle at build time, so changing it needs a redeploy.

### Railway

`railway.json` configures the API service: `npm ci` to build, `npm run api` to start, health check on `/api/health`. The health route touches nothing, so a probe running every few seconds costs no chain reads.

The process binds `PORT` if the platform sets one, falling back to `API_PORT` and then 4320.

Environment variables to set on the service: everything in `.env.example` that the API path needs, which is the Arc and Base Sepolia RPC URLs, the vault and token addresses, the Pyth adapter and feed id, the Circle API key and entity secret, the wallet ids, `DEPLOYER_PRIVATE_KEY`, plus `OPERATOR_SECRET` and `COVENANT_CORS_ORIGIN` pinned to the app's origin. Leave `COVENANT_ENV` unset: the API refuses to start in deployed mode without a secret and a pinned origin, which is the point.

**Mount a volume at `executor/.state` if you want settlement receipts to survive a redeploy.** Container filesystems are ephemeral. The API only reads that directory, so losing it costs the Settlements tab its history and nothing else. It becomes load-bearing the moment anything that *writes* settlements runs here, because that store is the record that stops a replayed event paying twice. Nothing in this repo's start scripts does today.

The monitor is a second service from the same repo with `npm run dashboard` as its start command. It is read-only, holds no keys, and mounts no write routes, which makes it the safe thing to link publicly.
