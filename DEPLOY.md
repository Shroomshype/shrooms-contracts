# Deploying Shrooms v2.0 to Elysium testnet

Written for whoever is doing the deploy. Follow it top to bottom. Each step says
what you're doing, what should happen, and how to tell it worked.

Nothing here touches real money. Elysium testnet gas is HYPE from a faucet.

---

## 0. What this is, in one page

Two tokens.

**SHROOMS** is what users buy and stake. It launches on
[Montra](https://montramarkets.xyz/) with the whole supply locked as liquidity —
no team allocation, nothing held back. We don't deploy it; we point at it.

**SPORES** is what they earn. It is minted *only* against HYPE the treasury has
already received from SHROOMS trading fees. There is no emission schedule, which
is the single most important thing to understand here: supply is an output of
real trading, not a policy. Every SPORES is redeemable for a pro-rata slice of
the treasury, and that redemption floor can never fall.

Three contracts we deploy, plus a timelock that owns them.

| Contract | What it does |
|---|---|
| `LiquiditySpores` | The HYPE treasury. Receives trading fees into a reserve, drips 2% of it into backing each week, mints SPORES against that, and redeems SPORES back for HYPE. Creates the SPORES token itself in its constructor. |
| `SporesToken` | SPORES. No owner, no pause. The treasury is the only address that can mint, fixed at construction with no setter. |
| `ShroomsFarm` | Staking across 8 strains, all of them SHROOMS or SHROOMS-HYPE LP. Rewards are **not** minted here — the treasury hands them over and the farm streams them. Holds the boost mechanics. |
| `ShroomsTimelock` | Owns the farm. Parameter changes must be queued publicly and wait out a delay. |

**The eight strains.** All stake SHROOMS or the LP; they differ by what they cost
to enter and the share of each harvest they draw.

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

Pools 0 and 5 are the free entrances. Everything else is a SPORES burn, which is
one of the two sinks that push the redemption floor up.

---

## 1. Set up

```bash
unzip shrooms.zip && cd shrooms
npm install
npm test
```

**Expect `63 passing`.** If not, stop and report it rather than continuing.

```bash
cp .env.example .env
```

```ini
PRIVATE_KEY=<a key that has ONLY ever touched testnets>
ELYSIUM_TESTNET_RPC=https://testnet-rpc.elysium.kinetiq.xyz
TIMELOCK_DELAY=3600
```

> **Generate a fresh throwaway wallet for this.** Never paste a key that holds
> anything real.

Get testnet HYPE from the Elysium faucet. Confirm what it actually dispenses —
gas on Elysium is HYPE, and some listings mention a separate token, so check you
received the thing that pays for gas.

**Network values** — worth confirming against the
[official docs](https://elysium.kinetiq.xyz/docs/connecting-to-elysium) before
spending anything:

| | |
|---|---|
| Chain ID | `99801` |
| RPC | `https://testnet-rpc.elysium.kinetiq.xyz` |
| Gas token | HYPE |
| Explorer | Blockscout, `elysium.kinetiq.xyz/testnet-explorer` |

Want to see the economics before touching a chain?

```bash
node scripts/simulate-year.js
```

That prints the same numbers the tokenomics page charts.

---

## 2. Deploy the staking tokens

Every strain stakes SHROOMS or the SHROOMS-HYPE LP — no outside assets.

**On mainnet** both come from Montra, and you skip this step entirely:

```bash
SHROOMS_ADDRESS=0x... SHROOMS_LP_ADDRESS=0x... npm run deploy:v2
```

**On testnet** neither exists yet, so deploy stand-ins plus a faucet:

```bash
npx hardhat run scripts/deploy-mocks.js --network elysiumTestnet
```

**Expect** two addresses (`tSHROOMS`, `tSH-LP`) and a faucet, written to
`deployments/elysiumTestnet.mocks.json`.

The script refuses to run on any chain ID that isn't a known testnet. These
tokens have an open mint — on a live chain they'd be a free money printer. Never
deploy `contracts/mocks/` to mainnet.

---

## 3. Deploy the protocol

```bash
npx hardhat run scripts/deploy-v2.js --network elysiumTestnet
```

**Expect** three addresses then eight strains listed `pool 0` through `pool 7`,
written to `deployments/elysiumTestnet.v2.json`.

Three things must be true, and the script prints each:

- **`SporesToken` was created *by* `LiquiditySpores`.** You never deploy it
  yourself. If you see two separate deploys, something is wrong.
- **`distributor set to the farm`.** This is the easiest step to lose. Without
  it, `drip()` mints SPORES to the owner instead of the farm and nothing is ever
  claimable — with no error to tell you.
- **Several pools share the same token.** That's intentional and `add()` only
  permits it when stated explicitly. Each pool tracks its own `totalStaked`, so
  they can't interfere.

---

## 4. Put HYPE in the treasury

Nothing happens until the treasury has HYPE. In production this is Montra's fee
route pointed at the treasury address. For testing, just send some:

```bash
cast send <LiquiditySpores> --value 50ether \
  --rpc-url https://testnet-rpc.elysium.kinetiq.xyz --private-key $PRIVATE_KEY
```

A plain transfer lands in **`reserve`**, which is deliberately *not* redeemable
yet. `drip()` is what moves it across into backing.

```bash
cast call <LiquiditySpores> "reserve()(uint256)" --rpc-url <rpc>
```

---

## 5. Run the weekly cycle

```bash
npx hardhat run scripts/drip-and-fund.js --network elysiumTestnet
```

Two things happen:

1. **`drip()`** moves 2% of the reserve into backing and mints the matching
   SPORES to the farm. Permissionless — anyone can call it.
2. **`notifyReward()`** per strain, splitting that SPORES by weight to stream
   over 7 days.

**Expect** a dripped amount, the new backing-per-SPORES figure, then eight lines
of per-strain allocation.

If it says *"drip not ready"*, the 7-day period hasn't elapsed. On a live testnet
you wait — there's no fast-forward on a real chain.

> In production, step 1 should be a cron job or Chainlink upkeep. Step 2 is
> owner-only, so once the timelock owns the farm it must be queued through the
> timelock. **Decide how that gets operated before you transfer ownership.**

---

## 6. Verify the whole thing works

```bash
npx hardhat run scripts/smoke-test.js --network elysiumTestnet
```

This walks the entire user journey against your live deployment and asserts the
things that matter: wiring, that fees land in reserve rather than backing, that
the drip is rate-limited, that gated strains refuse unopened stakers, that
`notifyReward` rejects a pot the farm can't afford, that rewards accrue and
claim, that **burning raises the floor**, and that both exits return principal.

**Expect `22 passed, 0 failed`.**

That burn-raises-the-floor line is the one to screenshot. It's the whole pitch,
demonstrated on chain.

---

## 7. Hand ownership to the timelock

Until this runs, one private key can change strain weights and fees in a single
transaction. Do it before anyone else touches the deployment.

```bash
TIMELOCK_DELAY=3600 npx hardhat run scripts/deploy-timelock.js --network elysiumTestnet
npx hardhat run scripts/timelock-accept.js --network elysiumTestnet   # queues
# wait out the delay
npx hardhat run scripts/timelock-accept.js --network elysiumTestnet   # executes
```

`deploy-timelock.js` aborts if the deployer still holds a privileged role
afterwards. `timelock-accept.js` reads the chain to work out which stage it's at,
so it's safe to re-run.

Verify with your own eyes rather than trusting the script:

```bash
cast call <ShroomsFarm> "owner()(address)" --rpc-url <rpc>   # == timelock
```

---

## 8. Verify on the explorer

Elysium runs Blockscout, not Etherscan. Config is already in `hardhat.config.js`.

```bash
npx hardhat verify --network elysiumTestnet <LiquiditySpores> <admin address>
npx hardhat verify --network elysiumTestnet <ShroomsFarm> <treasury address> <admin address>
```

People should be able to read what they're depositing into.

---

## 9. Point the site at it

Edit `js/config.js` in the [shrooms-web](https://github.com/Shroomshype/shrooms-web)
repo with the deployed addresses from
`deployments/elysiumTestnet.v2.json`:

```js
contracts: {
  LiquiditySpores: '0x…',
  SporesToken:     '0x…',
  ShroomsFarm:     '0x…',
  ShroomsTimelock: '0x…',
  Faucet:          '0x…',
},
tokens: { SHROOMS: '0x…', SHROOMS_LP: '0x…' },
tradeFeeRate: 0.01,      // set to Montra's real fee
ownerIsTimelock: true,
```

The tokenomics page checks whether `ShroomsFarm` is a real address. Until it is,
the burn tracker runs simulated data and says so on the page. Once set, it reads
`Fertilised` and `PoolUnlocked` events live.

Serve it with anything static — there's no build step:

```bash
cd ../shrooms-web && npx serve .
```

---

## Things that go wrong

**`earned()` returns zero forever.** Either `setDistributor` was never called
(step 3), or `drip-and-fund.js` hasn't run, or the reward period ended. Check
`spores.balanceOf(farm)` — if it's zero, the treasury never sent anything.

**`RewardTooHigh` on notifyReward.** The farm is being asked to promise more
SPORES than it holds. That revert is deliberate — it's the check that stops the
farm going quietly insolvent. Note it also excludes SPORES locked by users: that
is other people's principal and is never promised as rewards. Drip more before
notifying more.

**`TooSoon` on drip.** The 7-day period hasn't elapsed. On a live testnet, wait.

**`PoolIsGated` on stake.** That strain needs `unlockPool(pid)` first, which
burns its entry cost. Pools 0 and 5 are the free entrances.

**`AlreadyFertilised`.** The whole position is already covered. Stake more, then
fertilise the new amount.

**`DuplicatePool`.** You're adding a second pool for a token that already has one
without passing `allowSharedToken = true`. The lineup does this on purpose; a
hand-added pool shouldn't.

**Blockscout verification fails.** Check the constructor args match exactly and
that the compiler is 0.8.24 with optimizer runs 200. Remove the
`TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD` subtask at the top of
`hardhat.config.js` if your machine can download compilers normally — it exists
only for sandboxes with no access to the solc CDN.

---

## Before anyone calls this production

1. **Not audited.** The hardening in these contracts is a floor, not a review.
   See `AUDIT.md` for a reviewer's map of where the risk concentrates.
2. **No fuzz or invariant testing.** The reward accounting deserves Foundry
   invariant tests over `sum(earned) ≤ sporesBalance − totalLocked`.
3. **Montra's fee rate is confirmed at 1%, split 50/50.** Half the fee routes to
   the Liquidity Spores treasury and funds all rewards; half funds team and
   marketing. Set the fee route accordingly at launch — the treasury address is
   the one `deploy-v2.js` prints. All modelled figures use the treasury's half.
4. **`notifyReward` is owner-only.** Once the timelock owns the farm, the weekly
   reward split has to be queued through it. Operate that before transferring.
5. **The mocks must never reach mainnet.**
