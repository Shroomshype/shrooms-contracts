# Shrooms — contracts

Fee-funded yield farms on [Elysium](https://elysium.kinetiq.xyz/).

Stake **SHROOMS** or the SHROOMS-HYPE LP across eight strains and earn **SPORES**.
Rewards are paid out of real trading fees, not printed from an emission schedule —
which is the one decision everything else here follows from.

> **Deploying this?** Go straight to **[DEPLOY.md](DEPLOY.md)**. Ten steps,
> written to be followed top to bottom, saying what should happen at each one.
>
> **Reviewing it?** **[AUDIT.md](AUDIT.md)** maps where the risk concentrates and
> lists the specific questions worth answering.

| | |
|---|---|
| Version | **3.0** |
| Chain | Elysium testnet `99801` · gas in HYPE |
| Solidity | 0.8.24, OpenZeppelin 5 |
| Tests | **73 unit** · **24 on-chain smoke assertions** |
| Status | **unaudited** — testnet only |

Related: [shrooms-keeper](https://github.com/Shroomshype/shrooms-keeper) ·
[Website](https://github.com/Shroomshype/Website) ·
[X](https://x.com/Shroomshype) · [Telegram](https://t.me/shroomshype)

---

## The idea in one paragraph

SPORES cannot be printed. It is minted only against HYPE the treasury has already
received from SHROOMS trading fees, so supply is an *output* of real activity
rather than a policy anyone sets. Every SPORES is redeemable for a pro-rata slice
of that treasury, and the redemption floor can never fall — asserted on chain,
not merely intended. Spending SPORES on in-game boosts **burns** it and leaves
its HYPE behind, so the players who play make the token worth more for the
players who leave.

## Contracts

| Contract | Role |
|---|---|
| [`LiquiditySpores`](contracts/v2/LiquiditySpores.sol) | HYPE treasury. Fees land in a reserve; 2% drips into backing weekly and mints the matching SPORES. Redemption is pro-rata and always open — no cooldown, no pause, no owner switch. |
| [`SporesToken`](contracts/v2/SporesToken.sol) | SPORES. No owner, no pause. The treasury is the only minter, fixed at construction with no setter. |
| [`ShroomsFarm`](contracts/v2/ShroomsFarm.sol) | Staking across eight strains. Streams rewards it has been handed; it **cannot mint**. Holds the lock and fertiliser mechanics and the reward-distributor role. |
| [`ShroomsTimelock`](contracts/ShroomsTimelock.sol) | Owns the farm. Parameter changes queue publicly and wait out a delay. |

`contracts/` outside `v2` holds an earlier MasterChef-based design, kept so a
reviewer can diff the two approaches. It is not deployed.

## What changed in v3.0

**`notifyReward` is no longer `onlyOwner`.** It was — which meant that once the
timelock owned the farm, the routine weekly reward split needed a governance
proposal every single week. That conflates two different kinds of authority:

| | Example | Timelocked? |
|---|---|---|
| **Governance** | change weights, fees, durations | **Yes.** Users deserve a window to exit. |
| **Operations** | start a reward period with SPORES the farm already holds | **No.** Changes no parameter, risks nothing, happens weekly. |

`ShroomsFarm` now has a **`rewardDistributor`** — one address that may call
`notifyReward` and nothing else. Rate-limited to once per half a reward period,
revocable by the owner at any time, and the owner remains unrestricted.

> Set it to the keeper wallet **before** transferring ownership to the timelock.
> `setRewardDistributor` is owner-only, so afterwards it becomes a proposal itself.

It still cannot be permissionless: each call folds the unpaid remainder into a
fresh full duration, so an unbounded caller could restart periods repeatedly and
stretch the payout rate toward zero for free.

## Why the reserve drips

Trading fees arrive front-loaded — a launch spike, then decay toward a baseline.
Paying them out as they land burns the entire reward budget in the first month.

| Week 52, as a share of peak | |
|---|---|
| Pay fees out on arrival | 3.0% |
| Drip 2% a week | **27.9%** |

Because organic trading keeps topping the reserve up, it settles at an
equilibrium — fifty times weekly treasury income — rather than draining away.
Rewards become a standing income instead of a countdown.

```bash
node scripts/simulate-year.js      # the model, no chain required
```

## The strains

Every strain stakes SHROOMS or the SHROOMS-HYPE LP, and nothing else. The reward
pot is fixed by fee income, so a pool accepting an outside asset would pay SHROOMS
holders' rewards to people who never bought SHROOMS and generate no fees.

| pid | Strain | Stake | Entry burn | Share |
|---|---|---|---|---|
| 0 | Puffball Patch | SHROOMS | open | 4.0% |
| 1 | Inky Cap | SHROOMS | 25k SPORES | 5.7% |
| 2 | Morel Deep | SHROOMS | 75k | 7.7% |
| 3 | Chanterelle Grove | SHROOMS | 150k | 10.0% |
| 4 | Blue Mycena | SHROOMS | 300k | 12.7% |
| 5 | Enoki Cluster | SHROOMS-LP | open | 15.3% |
| 6 | Golden Cap | SHROOMS-LP | 250k | 20.0% |
| 7 | Amanita Prime | SHROOMS-LP | 600k | 24.7% |

Pools 0 and 5 are the free entrances. LP strains carry 60% of total weight,
because liquidity depth produces the volume that funds everything.

## Boosts, and why they are safe

| Mechanic | Effect | Sink |
|---|---|---|
| Lock SPORES, 7–180 days | +0.10x to +1.00x | temporary — returns whole |
| Fertilise stake, 0.1 SPORES/token | +0.50x on covered stake | **permanent burn** |
| Unlock a gated strain | access | **permanent burn** |

Capped at 3.00x, fixed in the contract.

A multiplier changes your share of a **fixed** pot, so it cannot create new
SPORES. Under an emissions model, buying a boost that raises your emission rate
is a reflexive loop. Under fee funding it is strictly zero-sum between stakers,
so the game layer can never inflate the token however it is tuned.

Fertiliser buys *capacity*, not a percentage: stake more and the new stake is
bare until you fertilise it too. A flat level ladder is a finite sink every
committed player exhausts in a few months, after which burn demand stops.
Charging per unit of stake ties burn volume to TVL.

## Quick start

```bash
npm install
npm test                       # 73 passing
node scripts/simulate-year.js  # the economics
```

```
contracts/v2/      the live design
contracts/         earlier MasterChef version, for comparison
contracts/mocks/   testnet-only stand-ins; open mint, never for mainnet
scripts/           deploy, drip, timelock handover, smoke test, simulation
test/              73 tests
```

The off-chain pieces live in their own repos:
[shrooms-keeper](https://github.com/Shroomshype/shrooms-keeper) calls the weekly
drip; [Website](https://github.com/Shroomshype/Website) is the front end
and the wagmi integration layer.

## Design decisions

This pattern is the most-forked and most-exploited in DeFi. Deviations from a
stock staking contract are deliberate:

| Decision | Reason |
|---|---|
| `backingPerSpore()` asserted non-decreasing | A drip that would reduce it reverts. The floor is enforced, not promised. |
| Reserve separate from backing | Fees are not redeemable until released, so the drip cannot be front-run. |
| `notifyReward` solvency check | A pool can never promise SPORES the farm does not hold. |
| `totalLocked` excluded from that check | Locked SPORES is other people's principal, never payable as rewards. |
| Distributor rate-limited | A compromised key cannot restart periods in a loop to dilute payouts. |
| Per-pool `totalStaked`, never `balanceOf` | Pools sharing a token cannot interfere — what makes the SHROOMS-only lineup safe. |
| Shared pools require an explicit flag | Deliberate, never accidental. |
| Boost ceilings as `constant` | No owner can tune them into a rug. |
| Deposits measured by balance delta | Fee-on-transfer tokens cannot desync accounting. |
| `emergencyWithdraw` unpausable | Principal exits even when everything else is frozen. |
| Pause stops deposits, never withdrawals | A pause protects users, not the team. |
| `drip()` permissionless | The weekly cycle does not depend on the team. |
| `Ownable2Step` throughout | A mistyped transfer cannot brick the protocol. |

## Known gaps

Listed plainly, because a reviewer will find them anyway.

1. **Not audited.** The hardening above is a floor, not a review.
2. **No fuzz or invariant testing.** The accounting deserves Foundry invariant
   tests over `sum(earned) ≤ sporesBalance − totalLocked`.
3. **`add()` accepts any ERC20.** Every token needs review before it gets a pool.
4. **The distributor role is a small amount of real power.** It can choose *when*
   a reward period restarts, within the rate limit. It cannot steal, mint, or
   change any parameter, and governance can revoke it.
5. **`contracts/mocks/` must never reach mainnet.** Open mint by design.

## Licence

MIT — see [LICENSE](LICENSE).
