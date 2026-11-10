const { expect } = require("chai");
const { ethers } = require("hardhat");

const E = (n) => ethers.parseEther(String(n));
const DAY = 86400;
const WEEK = 7 * DAY;

async function jump(s) {
  await ethers.provider.send("evm_increaseTime", [s]);
  await ethers.provider.send("evm_mine");
}

/** Move SPORES out of the farm (where drip mints it) into a user's hands. */
async function giveSpores(farm, spores, to, amount) {
  const addr = await farm.getAddress();
  await ethers.provider.send("hardhat_impersonateAccount", [addr]);
  await ethers.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
  const signer = await ethers.getSigner(addr);
  await spores.connect(signer).transfer(to, amount);
  await ethers.provider.send("hardhat_stopImpersonatingAccount", [addr]);
}

describe("Shrooms v2 — fee-funded staking, drip treasury, fertiliser boosts", function () {
  let owner, alice, bob, carol;
  let treasury, spores, farm, shrooms;

  beforeEach(async function () {
    [owner, alice, bob, carol] = await ethers.getSigners();

    treasury = await (await ethers.getContractFactory("LiquiditySpores")).deploy(owner.address);
    spores = await ethers.getContractAt("SporesToken", await treasury.spores());

    farm = await (await ethers.getContractFactory("ShroomsFarm")).deploy(
      await treasury.getAddress(), owner.address
    );
    await treasury.setDistributor(await farm.getAddress());

    shrooms = await (await ethers.getContractFactory("TestToken")).deploy("Shrooms", "SHROOMS", 18);
    await farm.add(await shrooms.getAddress(), WEEK, false, 0, false);

    for (const who of [alice, bob, carol]) {
      await shrooms.mint(who.address, E(10000));
      await shrooms.connect(who).approve(await farm.getAddress(), ethers.MaxUint256);
    }
  });

  // ============================================================== treasury

  describe("Two-bucket treasury", function () {
    it("puts incoming fees in reserve, not backing", async function () {
      await treasury.fund({ value: E(100) });
      expect(await treasury.reserve()).to.equal(E(100));
      expect(await treasury.backing()).to.equal(0);
      expect(await spores.totalSupply()).to.equal(0);
    });

    it("mints nothing until the first drip", async function () {
      await treasury.fund({ value: E(100) });
      await jump(WEEK);
      await treasury.drip();
      // 2% of 100 HYPE = 2 HYPE, bootstrapped at 10m SPORES/HYPE
      expect(await treasury.backing()).to.equal(E(2));
      expect(await treasury.reserve()).to.equal(E(98));
      expect(await spores.totalSupply()).to.equal(E(20_000_000));
    });

    it("enforces the drip period", async function () {
      await treasury.fund({ value: E(100) });
      await jump(WEEK);
      await treasury.drip();
      await expect(treasury.drip()).to.be.revertedWithCustomError(treasury, "TooSoon");
      await jump(WEEK);
      await treasury.drip();
    });

    it("lets anyone call drip", async function () {
      await treasury.fund({ value: E(100) });
      await jump(WEEK);
      await treasury.connect(carol).drip();
      expect(await treasury.backing()).to.be.gt(0);
    });

    it("holds the backing ratio flat across many drips", async function () {
      await treasury.fund({ value: E(100) });
      await jump(WEEK);
      await treasury.drip();
      const ratio = await treasury.backingPerSpore();

      for (let i = 0; i < 5; i++) {
        await jump(WEEK);
        await treasury.drip();
        expect(await treasury.backingPerSpore()).to.equal(ratio);
      }
    });

    it("never lets the reserve run dry", async function () {
      await treasury.fund({ value: E(100) });
      for (let i = 0; i < 30; i++) {
        await jump(WEEK);
        await treasury.drip();
      }
      expect(await treasury.reserve()).to.be.gt(0);
    });

    it("redeems pro-rata without moving the ratio", async function () {
      await treasury.fund({ value: E(100) });
      await jump(WEEK);
      await treasury.drip();
      await giveSpores(farm, spores, alice.address, E(1_000_000));

      const ratio = await treasury.backingPerSpore();
      const before = await ethers.provider.getBalance(alice.address);
      const tx = await treasury.connect(alice).redeem(E(1_000_000));
      const rc = await tx.wait();

      const after = await ethers.provider.getBalance(alice.address);
      expect(after - before + rc.gasUsed * rc.gasPrice).to.equal(E(0.1));
      expect(await treasury.backingPerSpore()).to.equal(ratio);
    });

    it("raises the floor on a donation and mints nothing", async function () {
      await treasury.fund({ value: E(100) });
      await jump(WEEK);
      await treasury.drip();
      const supply = await spores.totalSupply();
      const before = await treasury.backingPerSpore();

      await treasury.donate({ value: E(10) });
      expect(await spores.totalSupply()).to.equal(supply);
      expect(await treasury.backingPerSpore()).to.be.gt(before);
    });

    it("bounds the drip rate", async function () {
      await expect(treasury.setDripBps(0)).to.be.revertedWithCustomError(treasury, "BadDripBps");
      await expect(treasury.setDripBps(2000)).to.be.revertedWithCustomError(treasury, "BadDripBps");
      await treasury.setDripBps(500);
      expect(await treasury.dripBps()).to.equal(500);
    });

    it("turns HYPE into pure backing once the cap is reached", async function () {
      // Enough HYPE that proportional minting would blow past 1B SPORES.
      await treasury.fund({ value: E(100) });
      await jump(WEEK);
      await treasury.drip(); // 20m SPORES

      // crank the rate and drip until the cap binds
      await treasury.setDripBps(1000);
      for (let i = 0; i < 40; i++) {
        await jump(WEEK);
        await treasury.drip();
        if ((await spores.totalSupply()) >= (await treasury.MAX_SUPPLY())) break;
      }

      const supply = await spores.totalSupply();
      expect(supply).to.be.lte(await treasury.MAX_SUPPLY());

      if (supply === (await treasury.MAX_SUPPLY())) {
        const floorBefore = await treasury.backingPerSpore();
        await jump(WEEK);
        await treasury.drip();
        expect(await spores.totalSupply()).to.equal(supply);          // nothing minted
        expect(await treasury.backingPerSpore()).to.be.gt(floorBefore); // floor rose
      }
    });

    it("only lets the treasury mint", async function () {
      await expect(spores.connect(alice).mint(alice.address, E(1)))
        .to.be.revertedWithCustomError(spores, "OnlyTreasury");
    });

    it("only lets the distributor burn for boosts", async function () {
      await expect(treasury.connect(alice).burnForBoost(alice.address, E(1)))
        .to.be.revertedWithCustomError(treasury, "NotDistributor");
    });
  });

  // ================================================================= farm

  describe("Fee-funded rewards", function () {
    beforeEach(async function () {
      await treasury.fund({ value: E(100) });
      await jump(WEEK);
      await treasury.drip(); // 20m SPORES to the farm
    });

    it("refuses to promise rewards it does not hold", async function () {
      await expect(farm.notifyReward(0, E(999_000_000)))
        .to.be.revertedWithCustomError(farm, "RewardTooHigh");
    });

    it("streams a pot over the reward duration", async function () {
      await farm.connect(alice).stake(0, E(1000));
      await farm.notifyReward(0, E(7_000_000));
      await jump(DAY);
      expect(await farm.earned(0, alice.address)).to.be.closeTo(E(1_000_000), E(5000));
      await jump(6 * DAY);
      expect(await farm.earned(0, alice.address)).to.be.closeTo(E(7_000_000), E(10000));
    });

    it("stops paying when the period ends", async function () {
      await farm.connect(alice).stake(0, E(1000));
      await farm.notifyReward(0, E(7_000_000));
      await jump(10 * DAY);
      const a = await farm.earned(0, alice.address);
      await jump(10 * DAY);
      expect(await farm.earned(0, alice.address)).to.equal(a);
    });

    it("splits a pot by stake", async function () {
      await farm.connect(alice).stake(0, E(1000));
      await farm.connect(bob).stake(0, E(3000));
      await farm.notifyReward(0, E(7_000_000));
      await jump(WEEK);

      const a = await farm.earned(0, alice.address);
      const b = await farm.earned(0, bob.address);
      expect(b).to.be.closeTo(a * 3n, E(10000));
      expect(a + b).to.be.closeTo(E(7_000_000), E(20000));
    });
  });

  // =========================================================== fertiliser

  describe("Fertiliser", function () {
    beforeEach(async function () {
      await treasury.fund({ value: E(100) });
      await jump(WEEK);
      await treasury.drip();
      for (const who of [alice, bob]) {
        await giveSpores(farm, spores, who.address, E(500_000));
        await spores.connect(who).approve(await farm.getAddress(), ethers.MaxUint256);
      }
    });

    it("charges in proportion to the stake covered", async function () {
      expect(await farm.fertiliserCost(E(1000))).to.equal(E(100));
      expect(await farm.fertiliserCost(E(10000))).to.equal(E(1000));
    });

    it("boosts only the fertilised part of a position", async function () {
      await farm.connect(alice).stake(0, E(1000));
      await farm.connect(alice).fertilise(0, E(500)); // half

      // half at 1.5x, half at 1.0x = 1.25x blended
      expect(await farm.effectiveMultiplierOf(0, alice.address)).to.equal(E(1.25));
      const [, eff] = await farm.users(0, alice.address);
      expect(eff).to.equal(E(1250));
    });

    it("burns the cost and lifts the floor for everyone", async function () {
      await farm.connect(alice).stake(0, E(1000));
      const supplyBefore = await spores.totalSupply();
      const floorBefore = await treasury.backingPerSpore();

      await farm.connect(alice).fertilise(0, E(1000));

      expect(await spores.totalSupply()).to.equal(supplyBefore - E(100));
      expect(await treasury.backingPerSpore()).to.be.gt(floorBefore);
    });

    it("leaves new stake unfertilised — the sink does not run out", async function () {
      await farm.connect(alice).stake(0, E(1000));
      await farm.connect(alice).fertilise(0, E(1000));
      expect(await farm.unfertilised(0, alice.address)).to.equal(0);
      expect(await farm.effectiveMultiplierOf(0, alice.address)).to.equal(E(1.5));

      // growing the position creates fresh demand to burn
      await farm.connect(alice).stake(0, E(1000));
      expect(await farm.unfertilised(0, alice.address)).to.equal(E(1000));
      expect(await farm.effectiveMultiplierOf(0, alice.address)).to.equal(E(1.25));
    });

    it("will not sell fertiliser for land you do not have", async function () {
      await farm.connect(alice).stake(0, E(1000));
      await farm.connect(alice).fertilise(0, E(1000));
      await expect(farm.connect(alice).fertilise(0, E(1)))
        .to.be.revertedWithCustomError(farm, "AlreadyFertilised");
    });

    it("clamps an oversized purchase to the stake", async function () {
      await farm.connect(alice).stake(0, E(1000));
      const before = await spores.balanceOf(alice.address);
      await farm.connect(alice).fertilise(0, E(999999));
      // charged for 1000, not 999999
      expect(before - (await spores.balanceOf(alice.address))).to.equal(E(100));
    });

    it("pays a fertilised staker more than an identical bare one", async function () {
      await farm.connect(alice).stake(0, E(1000));
      await farm.connect(bob).stake(0, E(1000));
      await farm.connect(alice).fertilise(0, E(1000));

      await farm.notifyReward(0, E(7_000_000));
      await jump(WEEK);

      const a = await farm.earned(0, alice.address);
      const b = await farm.earned(0, bob.address);
      expect((a * 1000n) / b).to.be.closeTo(1500n, 20n);
    });

    it("conserves the pot — boosting redistributes, it never mints", async function () {
      await farm.connect(alice).stake(0, E(1000));
      await farm.connect(bob).stake(0, E(1000));
      await farm.connect(alice).fertilise(0, E(1000));
      await farm.connect(alice).lock(E(1000), 180 * DAY, [0]);

      const supplyBefore = await spores.totalSupply();
      await farm.notifyReward(0, E(7_000_000));
      await jump(WEEK);

      const total = (await farm.earned(0, alice.address)) + (await farm.earned(0, bob.address));
      expect(total).to.be.closeTo(E(7_000_000), E(20000));
      expect(await spores.totalSupply()).to.equal(supplyBefore);
    });
  });

  // ================================================================ locks

  describe("Locks", function () {
    beforeEach(async function () {
      await treasury.fund({ value: E(100) });
      await jump(WEEK);
      await treasury.drip();
      await giveSpores(farm, spores, alice.address, E(500_000));
      await spores.connect(alice).approve(await farm.getAddress(), ethers.MaxUint256);
    });

    it("stacks the lock bonus onto the base rate", async function () {
      await farm.connect(alice).stake(0, E(1000));
      await farm.connect(alice).lock(E(1000), 90 * DAY, [0]);
      expect(await farm.effectiveMultiplierOf(0, alice.address)).to.equal(E(1.6));
    });

    it("caps the combined multiplier", async function () {
      await farm.connect(alice).stake(0, E(1000));
      await farm.connect(alice).fertilise(0, E(1000));          // +0.50
      await farm.connect(alice).lock(E(1000), 180 * DAY, [0]);  // +1.00
      // 1.00 + 1.00 + 0.50 = 2.50, inside the 3.00 ceiling
      expect(await farm.effectiveMultiplierOf(0, alice.address)).to.equal(E(2.5));
      expect(await farm.multiplierOf(0, alice.address)).to.be.lte(await farm.MAX_TOTAL_MULTIPLIER());
    });

    it("returns locked SPORES whole after the term", async function () {
      const before = await spores.balanceOf(alice.address);
      await farm.connect(alice).lock(E(1000), WEEK, []);
      await expect(farm.connect(alice).unlock([])).to.be.revertedWithCustomError(farm, "LockStillActive");
      await jump(WEEK + 1);
      await farm.connect(alice).unlock([]);
      expect(await spores.balanceOf(alice.address)).to.equal(before);
    });

    it("drops the bonus when the lock expires", async function () {
      await farm.connect(alice).stake(0, E(1000));
      await farm.connect(alice).lock(E(1000), WEEK, [0]);
      expect(await farm.effectiveMultiplierOf(0, alice.address)).to.equal(E(1.1));
      await jump(WEEK + 1);
      expect(await farm.effectiveMultiplierOf(0, alice.address)).to.equal(E(1));
    });

    it("lets anyone kick an expired lock to correct the pool total", async function () {
      await farm.connect(alice).stake(0, E(1000));
      await farm.connect(alice).lock(E(1000), WEEK, [0]);
      await jump(WEEK + 1);

      const [, stale] = await farm.users(0, alice.address);
      expect(stale).to.equal(E(1100));

      await farm.connect(bob).kick(0, alice.address);
      const [, fresh] = await farm.users(0, alice.address);
      expect(fresh).to.equal(E(1000));
      await expect(farm.connect(bob).kick(0, alice.address))
        .to.be.revertedWithCustomError(farm, "NothingToKick");
    });

    it("refuses a shorter term while a lock is live", async function () {
      await farm.connect(alice).lock(E(1000), 90 * DAY, []);
      await expect(farm.connect(alice).lock(E(100), WEEK, []))
        .to.be.revertedWithCustomError(farm, "BadTerm");
    });
  });

  // =============================================================== gating

  describe("Gated strains", function () {
    beforeEach(async function () {
      await treasury.fund({ value: E(100) });
      await jump(WEEK);
      await treasury.drip();
      await giveSpores(farm, spores, alice.address, E(500_000));
      await spores.connect(alice).approve(await farm.getAddress(), ethers.MaxUint256);

      const leg = await (await ethers.getContractFactory("TestToken")).deploy("Legendary", "LEG", 18);
      await farm.add(await leg.getAddress(), WEEK, true, E(100_000), false);
      await leg.mint(alice.address, E(5000));
      await leg.connect(alice).approve(await farm.getAddress(), ethers.MaxUint256);
    });

    it("blocks staking until unlocked", async function () {
      await expect(farm.connect(alice).stake(1, E(100)))
        .to.be.revertedWithCustomError(farm, "PoolIsGated");
    });

    it("opens for a burn, once, per address", async function () {
      const supply = await spores.totalSupply();
      await farm.connect(alice).unlockPool(1);
      expect(await spores.totalSupply()).to.equal(supply - E(100_000));
      await farm.connect(alice).stake(1, E(100));

      await expect(farm.connect(alice).unlockPool(1))
        .to.be.revertedWithCustomError(farm, "AlreadyUnlocked");
      await expect(farm.connect(bob).stake(1, E(100)))
        .to.be.revertedWithCustomError(farm, "PoolIsGated");
    });
  });

  // =============================================================== safety

  describe("Safety", function () {
    beforeEach(async function () {
      await treasury.fund({ value: E(100) });
      await jump(WEEK);
      await treasury.drip();
    });

    it("returns principal on emergency withdraw and forfeits rewards", async function () {
      await farm.connect(alice).stake(0, E(1000));
      await farm.notifyReward(0, E(7_000_000));
      await jump(3 * DAY);
      await farm.connect(alice).emergencyWithdraw(0);
      expect(await shrooms.balanceOf(alice.address)).to.equal(E(10000));
      expect(await spores.balanceOf(alice.address)).to.equal(0);
    });

    it("clears fertiliser when the position is emergency-exited", async function () {
      await giveSpores(farm, spores, alice.address, E(500_000));
      await spores.connect(alice).approve(await farm.getAddress(), ethers.MaxUint256);
      await farm.connect(alice).stake(0, E(1000));
      await farm.connect(alice).fertilise(0, E(1000));
      await farm.connect(alice).emergencyWithdraw(0);
      expect(await farm.unfertilised(0, alice.address)).to.equal(0);
      const pool = await farm.pools(0);
      expect(pool.totalEffective).to.equal(0);
    });

    it("keeps withdrawals open while paused", async function () {
      await farm.connect(alice).stake(0, E(1000));
      await farm.pause();
      await expect(farm.connect(alice).stake(0, E(1))).to.be.reverted;
      await expect(farm.connect(alice).withdraw(0, E(1000))).to.not.be.reverted;
    });

    it("rejects a duplicate pool", async function () {
      await expect(farm.add(await shrooms.getAddress(), WEEK, false, 0, false))
        .to.be.revertedWithCustomError(farm, "DuplicatePool");
    });

    it("bounds the reward duration", async function () {
      const t = await (await ethers.getContractFactory("TestToken")).deploy("X", "X", 18);
      await expect(farm.add(await t.getAddress(), 60, false, 0, false))
        .to.be.revertedWithCustomError(farm, "BadDuration");
    });

    it("keeps effective supply equal to the sum of effective balances", async function () {
      await farm.connect(alice).stake(0, E(1000));
      await farm.connect(bob).stake(0, E(2500));
      await farm.connect(carol).stake(0, E(700));
      await farm.connect(bob).withdraw(0, E(500));

      const [, ea] = await farm.users(0, alice.address);
      const [, eb] = await farm.users(0, bob.address);
      const [, ec] = await farm.users(0, carol.address);
      const pool = await farm.pools(0);
      expect(pool.totalEffective).to.equal(ea + eb + ec);
      expect(pool.totalStaked).to.equal(E(3700));
    });
  });
});

/* Added when the lineup moved to SHROOMS-only: several strains deliberately
   stake the same token, so the duplicate guard had to become explicit. */
describe("Shared-token pools", function () {
  let owner, alice, treasury, spores, farm, shrooms;
  const E2 = (n) => ethers.parseEther(String(n));

  beforeEach(async function () {
    [owner, alice] = await ethers.getSigners();
    treasury = await (await ethers.getContractFactory("LiquiditySpores")).deploy(owner.address);
    spores = await ethers.getContractAt("SporesToken", await treasury.spores());
    farm = await (await ethers.getContractFactory("ShroomsFarm")).deploy(
      await treasury.getAddress(), owner.address
    );
    await treasury.setDistributor(await farm.getAddress());
    shrooms = await (await ethers.getContractFactory("TestToken")).deploy("Shrooms", "SHROOMS", 18);
    await shrooms.mint(alice.address, E2(10000));
    await shrooms.connect(alice).approve(await farm.getAddress(), ethers.MaxUint256);
  });

  it("still blocks an accidental duplicate", async function () {
    await farm.add(await shrooms.getAddress(), 7 * 86400, false, 0, false);
    await expect(farm.add(await shrooms.getAddress(), 7 * 86400, false, 0, false))
      .to.be.revertedWithCustomError(farm, "DuplicatePool");
  });

  it("allows a shared pool when stated explicitly", async function () {
    await farm.add(await shrooms.getAddress(), 7 * 86400, false, 0, false);
    await farm.add(await shrooms.getAddress(), 7 * 86400, false, 0, true);
    expect(await farm.poolLength()).to.equal(2);
    expect(await farm.poolsForToken(await shrooms.getAddress())).to.equal(2);
  });

  it("keeps two pools on the same token completely independent", async function () {
    await farm.add(await shrooms.getAddress(), 7 * 86400, false, 0, false);
    await farm.add(await shrooms.getAddress(), 7 * 86400, false, 0, true);

    await farm.connect(alice).stake(0, E2(1000));
    await farm.connect(alice).stake(1, E2(3000));

    const p0 = await farm.pools(0), p1 = await farm.pools(1);
    expect(p0.totalStaked).to.equal(E2(1000));
    expect(p1.totalStaked).to.equal(E2(3000));

    // withdrawing from one must not touch the other's accounting
    await farm.connect(alice).withdraw(0, E2(1000));
    expect((await farm.pools(0)).totalStaked).to.equal(0);
    expect((await farm.pools(1)).totalStaked).to.equal(E2(3000));
    expect(await shrooms.balanceOf(await farm.getAddress())).to.equal(E2(3000));
  });

  it("reserves locked SPORES from the reward solvency check", async function () {
    await farm.add(await shrooms.getAddress(), 7 * 86400, false, 0, false);
    await treasury.fund({ value: E2(100) });
    await ethers.provider.send("evm_increaseTime", [7 * 86400]);
    await ethers.provider.send("evm_mine");
    await treasury.drip();

    const held = await spores.balanceOf(await farm.getAddress());

    // a locker's principal arrives in the farm's balance
    const addr = await farm.getAddress();
    await ethers.provider.send("hardhat_impersonateAccount", [addr]);
    await ethers.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
    const fs2 = await ethers.getSigner(addr);
    await spores.connect(fs2).transfer(alice.address, held / 2n);
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [addr]);
    await spores.connect(alice).approve(addr, ethers.MaxUint256);
    await farm.connect(alice).lock(held / 2n, 7 * 86400, []);

    expect(await farm.totalLocked()).to.equal(held / 2n);
    // the farm's balance is back to `held`, but only half of it is ours to give
    await expect(farm.notifyReward(0, held)).to.be.revertedWithCustomError(farm, "RewardTooHigh");
    await farm.notifyReward(0, held / 2n); // this much is genuinely available
  });
});
