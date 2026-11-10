# Shrooms — contracts

Fee-funded yield farms on [Elysium](https://elysium.kinetiq.xyz/).

Stake **SHROOMS** or the SHROOMS-HYPE LP across eight strains and earn **SPORES**.
Rewards are paid out of real trading fees, not printed from an emission schedule —
which is the one decision everything else here follows from.

| | |
|---|---|
| Chain | Elysium (Arbitrum Orbit, settles to HyperEVM) |
| Testnet | `99801` · gas in HYPE |
| Solidity | 0.8.24, OpenZeppelin 5 |
| Tests | 63 unit · 22 on-chain smoke assertions |
| Status | **unaudited** — testnet only |

Related: [shrooms-web](https://github.com/Shroomshype/shrooms-web) ·
[X](https://x.com/Shroomshype) · [Telegram](https://t.me/shroomshype)

---

## The idea in one paragraph

SPORES cannot be printed. It is minted only against HYPE the treasury has already
received from SHROOMS trading fees, so supply is an *output* of real activity
rather than a policy anyone sets. Every SPORES is redeemable for a pro-rata slice
of that treasury, and the redemption floor can never fall — it is asserted on
chain, not merely intended. Spending SPORES on in-game boosts **burns** it and
leaves its HYPE behind, so the players who play make the token worth more for the
players who leave.

## Contracts

All current work is in [`contracts/v2`](contracts/v2).

| Contract | Role |
|---|---|
| [`LiquiditySpores`](contracts/v2/LiquiditySpores.sol) | The HYPE treasury. Fees land in a reserve; 2% drips into backing each week and mints the matching SPORES. Redemption is pro-rata and always open — no cooldown, no pause, no owner switch. |
| [`SporesToken`](contracts/v2/SporesToken.sol) | SPORES. No owner, no pause. The treasury is the only minter, fixed at construction with no setter. |
| [`ShroomsFarm`](contracts/v2/ShroomsFarm.sol) | Staking across eight strains. Streams rewards it has been handed; it **cannot mint**. Holds the lock and fertiliser mechanics. |
| [`ShroomsTimelock`](contracts/ShroomsTimelock.sol) | Owns the farm. Parameter changes queue publicly and wait out a delay. |

`contracts/` (outside `v2`) holds an earlier MasterChef-based design, kept so a
reviewer can diff the two approaches. It is not deployed.

## Why the reserve drips

Trading fees arrive front-loaded — a launch spike, then decay toward a baseline.
Paying them out as they land burns the entire reward budget in the first month.
Holding them and releasing 2% a week turns a spike into an income:

| Week 52, as a share of peak | |
|---|---|
| Pay fees out on arrival | 3.0% |
| Drip 2% a week | **27.9%** |

Because organic trading keeps topping the reserve up, it settles at an
equilibrium — fifty times weekly treasury income — rather than draining away.
Rewards become a standing income instead of a countdown.

Run the model yourself, no chain required:

```bash
node scripts/simulate-year.js
```

## The strains

Every strain stakes SHROOMS or the SHROOMS-HYPE LP, and nothing else. The reward
pot is fixed by fee income, so a pool accepting an outside asset would pay SHROOMS
holders' rewards to people who never bought SHROOMS and generate no fees. Strains
differ by commitment instead.

| pid | Strain | Stake | Entry burn | Share of harvest |
|---|---|---|---|---|
| 0 | Puffball Patch | SHROOMS | open | 4.0% |
| 1 | Inky Cap | SHROOMS | 25k SPORES | 5.7% |
| 2 | Morel Deep | SHROOMS | 75k | 7.7% |
| 3 | Chanterelle Grove | SHROOMS | 150k | 10.0% |
| 4 | Blue Mycena | SHROOMS | 300k | 12.7% |
| 5 | Enoki Cluster | SHROOMS-LP | open | 15.3% |
| 6 | Golden Cap | SHROOMS-LP | 250k | 20.0% |
| 7 | Amanita Prime | SHROOMS-LP | 600k | 24.7% |

LP strains carry 60% of total weight, because liquidity depth is what produces the
trading volume that funds everything. Pools 0 and 5 are the free entrances; the
rest cost a SPORES burn, which is one of the two sinks pushing the floor up.

## Boosts, and why they are safe

| Mechanic | Effect | Sink |
|---|---|---|
| Lock SPORES, 7–180 days | +0.10x to +1.00x | temporary — returns whole |
| Fertilise stake, 0.1 SPORES/token | +0.50x on covered stake | **permanent burn** |
| Unlock a gated strain | access | **permanent burn** |

Everything together caps at 3.00x, fixed in the contract.

A multiplier changes your share of a **fixed** pot, so it cannot create new SPORES.
Under an emissions model, buying a boost that raises your emission rate is a
reflexive loop — spend to earn, earn to spend. Under fee funding it is strictly
zero-sum between stakers, so the game layer can never inflate the token no matter
how it is tuned.

Fertiliser buys *capacity*, not a percentage: stake more and the new stake is bare
until you fertilise it too. A flat level ladder is a finite sink every committed
player exhausts in a few months, after which burn demand stops. Charging per unit
of stake ties burn volume to TVL, so the sink grows as the protocol does.

## Quick start

```bash
npm install
npm test                       # 63 passing
node scripts/simulate-year.js  # the economics
```

Deploying to Elysium testnet is covered step by step in **[DEPLOY.md](DEPLOY.md)**.
Reviewing? **[AUDIT.md](AUDIT.md)** maps where the risk concentrates.

```
contracts/v2/      the live design
contracts/         earlier MasterChef version, for comparison
contracts/mocks/   testnet-only stand-ins; open mint, never for mainnet
scripts/           deploy, drip, timelock handover, smoke test, simulation
test/              63 tests
```

## Design decisions

This pattern is the most-forked and most-exploited in DeFi. Deviations from a
stock staking contract are deliberate:

| Decision | Reason |
|---|---|
| `backingPerSpore()` asserted non-decreasing | A drip that would reduce it reverts. The floor is enforced, not promised. |
| Reserve separate from backing | Fees are not redeemable until released, so the drip cannot be front-run. |
| `notifyReward` solvency check | A pool can never promise SPORES the farm does not hold. |
| `totalLocked` excluded from that check | Locked SPORES is other people's principal and is never payable as rewards. |
| Per-pool `totalStaked`, never `balanceOf` | Pools sharing a token cannot interfere — which is what makes the SHROOMS-only lineup safe. |
| Shared pools require an explicit flag | Deliberate, never accidental. |
| Boost ceilings as `constant` | No owner can tune them into a rug. |
| Deposits measured by balance delta | Fee-on-transfer tokens cannot desync accounting. |
| `emergencyWithdraw` unpausable | Principal exits even when everything else is frozen. |
| Pause stops deposits, never withdrawals | A pause protects users, not the team. |
| `drip()` permissionless | The weekly cycle does not depend on the team being awake. |
| `Ownable2Step` throughout | A mistyped transfer cannot brick the protocol. |

## Status and known gaps

Listed plainly, because a reviewer will find them anyway.

1. **Not audited.** The hardening above is a floor, not a review.
2. **No fuzz or invariant testing.** The accounting deserves Foundry invariant
   tests over `sum(earned) ≤ sporesBalance − totalLocked`.
3. **`add()` accepts any ERC20.** Every token needs review before it gets a pool.
4. **`notifyReward` is owner-only.** Once the timelock owns the farm, the weekly
   split must be queued through it. Decide how that is operated before transferring.
5. **`contracts/mocks/` must never reach mainnet.** Open mint by design.

## Licence

MIT — see [LICENSE](LICENSE).
