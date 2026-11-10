# Notes for a reviewer

A map of what is here and where the risk concentrates, so review time goes to the parts that
hold value rather than to the landing page.

## Scope, in priority order

| Priority | Path | Lines | Why |
|---|---|---|---|
| 1 | `contracts/v2/ShroomsFarm.sol` | ~520 | Holds all deposits. Reward accounting, boosts and the distributor role. |
| 1 | `contracts/v2/LiquiditySpores.sol` | ~250 | Holds all HYPE. The backing invariant lives here. |
| 2 | `contracts/SporeVault.sol` | ~230 | Share maths; first-depositor and donation attacks live here. |
| 3 | `contracts/SporeToken.sol` | ~40 | Mint authority and the supply cap. |
| 4 | `contracts/ShroomsTimelock.sol` | ~30 | Thin wrapper over OZ `TimelockController`; check the role wiring in `scripts/deploy-timelock.js`. |
| 5 | `scripts/deploy*.js` | — | Deployment order and the ownership handover. Pool 0 must be SPORE. |
| 6 | `web3/hooks/useFarms.ts` | ~180 | Approval UX. Infinite approval is the default with an exact-amount path beside it. |
| — | `contracts/ShroomLens.sol` | ~90 | Read-only, no state. |
| — | `contracts/mocks/**` | — | Testnet only, open mint by design. Not for mainnet. |
| — | `site/**` | — | Static pages. No wallet code yet; the connect button is a stub. |

## Invariants we believe hold

Worth attacking directly:

1. `sum(users[pid][*].amount) == pools[pid].totalStaked` for every pool.
2. SPORE paid as reward never comes from principal staked in the SPORE pool
   (`SporeFarm._safeSporeTransfer` subtracts `pools[sporePid].totalStaked` before paying).
3. `spore.totalSupply() <= MAX_SUPPLY` under every sequence, including when `updatePool` would
   mint past the cap — it clamps and emissions simply stop.
4. `emissionPerSecond <= MAX_EMISSION_PER_SECOND` even when set through the timelock.
5. `depositFeeBps <= MAX_DEPOSIT_FEE_BPS` for every pool, at `add` and at `set`.
6. `vault.pricePerShare()` is non-decreasing except for the fees taken in `harvest`.
7. `emergencyWithdraw` always returns the caller's full principal and cannot be blocked.
8. A paused vault still permits `withdraw` and `withdrawAll`.

Numbers 2, 3, 4, 6, 7 and 8 have tests. None of them have fuzz coverage, which is gap 2 in the
README.

## Specific questions we would like answered

1. **Rounding in `_payout`.** `rewardDebt` is recomputed after every balance change. Is there a
   sequence of deposit/withdraw/harvest that leaves dust claimable twice across pools?
2. **The vault's `withdraw` path.** When idle balance is short, it calls `farm.withdraw`, which
   also pays pending rewards into the vault. We then clamp `amount` to the balance. Can a user
   withdraw more than their share of `totalAssets()` by timing that against a harvest?
3. **First-depositor.** `MINIMUM_SHARES = 1e6` is locked on the first deposit. Is that enough
   given SPORE has 18 decimals, or should it scale with the first deposit?
4. **Fee-on-transfer and rebasing tokens.** Deposits measure the balance delta, but a rebasing
   token would still drift from `totalStaked` over time. We intend to keep such tokens out by
   policy — is a code-level guard warranted?
5. **Timelock role setup.** Executor is `address(0)` so anyone can execute a waited-out
   operation, and admin is `address(0)`. Does that combination create a path we have missed?
6. **Approval UX.** `useFarms.ts` offers infinite approval by default. Given this is a farm
   users enter repeatedly, is that the right default or should exact-amount be?

## Reproducing

```bash
npm install
npm test                    # 21 passing
npm run node                # terminal 1
npm run deploy:mocks -- --network localFork
npm run deploy -- --network localFork
npm run deploy:timelock -- --network localFork
npm run timelock:accept -- --network localFork
```

The last two were rehearsed end to end on a local chain. After the handover the deployer holds
no privileged role, both contracts are owned by the timelock, and `setEmission` from the old
owner reverts.

## What is deliberately not fixed

- Ownership is a single key between `deploy.js` and `timelock-accept.js` completing. That window
  is unavoidable with `Ownable2Step`; what matters is that it closes before anything holds value.
- The site quotes four-digit APYs. They are placeholder figures for a testnet build and every
  page says so in the footer. If that disclaimer ever stops being true, it is a finding.
