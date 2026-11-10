/* End-to-end smoke test against a live deployment: walks the whole user journey
   and asserts the things that actually matter.

   Safe to run on a testnet with a funded throwaway key. On a local node it
   fast-forwards time; on a real chain it skips the steps that need that.

     npx hardhat run scripts/smoke-test.js --network localFork            */

const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const E = (n) => ethers.parseEther(String(n));
let pass = 0, fail = 0;

function check(label, ok, detail) {
  (ok ? pass++ : fail++);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.v2.json`);
  if (!fs.existsSync(file)) throw new Error(`No deployments/${network.name}.v2.json — deploy first`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const isLocal = [31337, 1337].includes(chainId);

  const [me] = await ethers.getSigners();
  const treasury = await ethers.getContractAt("LiquiditySpores", d.contracts.LiquiditySpores);
  const spores = await ethers.getContractAt("SporesToken", d.contracts.SporesToken);
  const farm = await ethers.getContractAt("ShroomsFarm", d.contracts.ShroomsFarm);
  const shrooms = await ethers.getContractAt("TestToken", d.shroomsToken);

  console.log(`\nSmoke test on ${network.name} (chain ${chainId}) as ${me.address}\n`);

  // ---------------------------------------------------------- wiring
  console.log("Wiring");
  check("distributor is the farm", (await treasury.distributor()) === d.contracts.ShroomsFarm);
  check("SPORES mint authority is the treasury", (await spores.treasury()) === d.contracts.LiquiditySpores);
  check("eight strains deployed", Number(await farm.poolLength()) === 8);
  check("farm knows the treasury", (await farm.treasury()) === d.contracts.LiquiditySpores);

  // ---------------------------------------------------------- funding
  // Deliberately relative, not absolute: this has to be runnable against a
  // live deployment that has already been dripped, not only a pristine one.
  console.log("\nTreasury");
  const reserveBefore = await treasury.reserve();
  const backingBefore = await treasury.backing();
  const supplyAtStart = await spores.totalSupply();

  await (await me.sendTransaction({ to: d.contracts.LiquiditySpores, value: E(50) })).wait();

  check("fees land in reserve", (await treasury.reserve()) === reserveBefore + E(50));
  check("fees do not land in backing", (await treasury.backing()) === backingBefore);
  check("sending fees mints nothing", (await spores.totalSupply()) === supplyAtStart);

  if (isLocal) {
    await ethers.provider.send("evm_increaseTime", [7 * 86400]);
    await ethers.provider.send("evm_mine");
  }

  const ready = Number(await treasury.dripReadyAt());
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  if (now < ready) {
    console.log(`\n  (drip not ready for ${Math.ceil((ready - now) / 3600)}h — skipping the rest)`);
    return report();
  }

  const floorBefore0 = await treasury.backingPerSpore();
  const reservePre = await treasury.reserve();
  const backingPre = await treasury.backing();
  const farmPre = await spores.balanceOf(d.contracts.ShroomsFarm);
  const expectedMove = (reservePre * 2n) / 100n;

  await (await treasury.drip()).wait();

  check("drip moved 2% of the reserve into backing",
        (await treasury.backing()) === backingPre + expectedMove,
        ethers.formatEther(expectedMove) + " HYPE");
  check("drip minted to the farm", (await spores.balanceOf(d.contracts.ShroomsFarm)) > farmPre);
  check("floor did not fall", (await treasury.backingPerSpore()) >= floorBefore0);
  check("second drip is rate-limited",
        await treasury.drip().then(() => false).catch(() => true));

  // ---------------------------------------------------------- staking
  console.log("\nStaking");
  await (await shrooms.mint(me.address, E(10000))).wait();
  await (await shrooms.approve(d.contracts.ShroomsFarm, ethers.MaxUint256)).wait();
  await (await farm.stake(0, E(1000))).wait();
  const [bal] = await farm.users(0, me.address);
  check("staked into the open strain", bal === E(1000));

  check("gated strain refuses an unopened staker",
        await farm.stake(1, E(1)).then(() => false).catch(() => true));

  // fund pool 0 so rewards actually stream. notifyReward is restricted to the
  // owner or the named distributor, so skip gracefully if this wallet is neither.
  const held = await spores.balanceOf(d.contracts.ShroomsFarm);
  const farmOwner = await farm.owner();
  const rewardDist = await farm.rewardDistributor();
  const mayNotify = [farmOwner.toLowerCase(), rewardDist.toLowerCase()].includes(me.address.toLowerCase());

  if (mayNotify) {
    await (await farm.notifyReward(0, held / 10n)).wait();
    check("notifyReward accepted an affordable pot", true);
    check("notifyReward rejects an unaffordable pot",
          await farm.notifyReward(0, held * 100n).then(() => false).catch(() => true));
  } else {
    console.log(`  (skipped notifyReward — this wallet is neither owner nor distributor)`);
    console.log(`   owner ${farmOwner}`);
    console.log(`   distributor ${rewardDist}`);
  }
  check("a stranger cannot call notifyReward",
        await farm.connect(ethers.Wallet.createRandom().connect(ethers.provider))
          .notifyReward.staticCall(0, 1n).then(() => false).catch(() => true));

  if (isLocal) {
    await ethers.provider.send("evm_increaseTime", [3600]);
    await ethers.provider.send("evm_mine");
  }
  const earned = await farm.earned(0, me.address);
  check("rewards accrue", earned > 0n, ethers.formatEther(earned) + " SPORES");

  await (await farm.claim(0)).wait();
  const myS = await spores.balanceOf(me.address);
  check("claim paid out", myS > 0n, ethers.formatEther(myS) + " SPORES");

  // ------------------------------------------------------- the burn
  console.log("\nBurn raises the floor");
  const floorBefore = await treasury.backingPerSpore();
  const supplyBefore = await spores.totalSupply();
  const cost = await farm.fertiliserCost(E(1000));

  if (myS >= cost) {
    await (await farm.fertilise(0, E(1000))).wait();
    check("fertiliser burned SPORES", (await spores.totalSupply()) === supplyBefore - cost);
    check("floor ROSE after the burn", (await treasury.backingPerSpore()) > floorBefore,
          ethers.formatEther(floorBefore) + " -> " + ethers.formatEther(await treasury.backingPerSpore()));
    check("multiplier is now 1.5x on the fertilised stake",
          (await farm.effectiveMultiplierOf(0, me.address)) === E(1.5));
  } else {
    console.log(`  (skipped fertiliser — need ${ethers.formatEther(cost)} SPORES, have ${ethers.formatEther(myS)})`);
  }

  // --------------------------------------------------------- exits
  console.log("\nExits");
  const before = await shrooms.balanceOf(me.address);
  await (await farm.withdraw(0, E(500))).wait();
  check("withdraw returns principal", (await shrooms.balanceOf(me.address)) === before + E(500));

  await (await farm.emergencyWithdraw(0)).wait();
  const [after] = await farm.users(0, me.address);
  check("emergency withdraw empties the position", after === 0n);
  check("pool total went to zero", (await farm.pools(0)).totalStaked === 0n);

  report();
}

function report() {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log("Deployment looks healthy.\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
