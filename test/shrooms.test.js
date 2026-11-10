const { expect } = require("chai");
const { ethers } = require("hardhat");

const E = (n) => ethers.parseEther(String(n));
const DAY = 86400;

async function jump(seconds) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine");
}

describe("Shrooms", function () {
  let owner, alice, bob, treasury;
  let spore, farm, vault, lp;

  beforeEach(async function () {
    [owner, alice, bob, treasury] = await ethers.getSigners();

    spore = await (await ethers.getContractFactory("SporeToken")).deploy(owner.address);
    const now = (await ethers.provider.getBlock("latest")).timestamp;

    farm = await (await ethers.getContractFactory("SporeFarm")).deploy(
      await spore.getAddress(),
      E(0.1), // 0.1 SPORE/sec
      now,
      treasury.address,
      owner.address
    );
    await spore.grantRole(await spore.MINTER_ROLE(), await farm.getAddress());

    lp = await (await ethers.getContractFactory("MockERC20")).deploy("LP", "LP");

    // pool 0 = SPORE itself (the vault farms this), pool 1 = an LP token
    await farm.add(await spore.getAddress(), 400, 0);
    await farm.add(await lp.getAddress(), 100, 200); // 2% deposit fee

    vault = await (await ethers.getContractFactory("SporeVault")).deploy(
      await spore.getAddress(),
      await farm.getAddress(),
      0,
      treasury.address,
      owner.address
    );

    // seed some SPORE by letting alice farm the LP pool first
    await lp.mint(alice.address, E(1000));
  });

  it("emits SPORE proportionally to alloc points", async function () {
    await lp.connect(alice).approve(await farm.getAddress(), E(1000));
    await farm.connect(alice).deposit(1, E(100));

    await jump(1000);
    const pending = await farm.pendingSpore(1, alice.address);
    // pool 1 has 100/500 of alloc → 0.02 SPORE/sec → ~20 SPORE over 1000s
    expect(pending).to.be.closeTo(E(20), E(0.1));
  });

  it("charges the deposit fee to the collector and caps it", async function () {
    await lp.connect(alice).approve(await farm.getAddress(), E(1000));
    await farm.connect(alice).deposit(1, E(100));

    expect(await lp.balanceOf(treasury.address)).to.equal(E(2)); // 2%
    const [staked] = await farm.users(1, alice.address);
    expect(staked).to.equal(E(98));

    await expect(farm.set(1, 100, 401)).to.be.revertedWithCustomError(farm, "FeeTooHigh");
  });

  it("refuses a second pool for the same token", async function () {
    await expect(farm.add(await lp.getAddress(), 100, 0)).to.be.revertedWithCustomError(farm, "DuplicatePool");
  });

  it("caps the emission rate", async function () {
    await expect(farm.setEmission(E(2))).to.be.revertedWithCustomError(farm, "EmissionTooHigh");
  });

  it("returns principal on emergencyWithdraw and forfeits rewards", async function () {
    await lp.connect(alice).approve(await farm.getAddress(), E(1000));
    await farm.connect(alice).deposit(1, E(100));
    await jump(DAY);

    await farm.connect(alice).emergencyWithdraw(1);
    expect(await lp.balanceOf(alice.address)).to.equal(E(998)); // 1000 - 2% fee
    expect(await spore.balanceOf(alice.address)).to.equal(0);
    const [staked] = await farm.users(1, alice.address);
    expect(staked).to.equal(0);
  });

  it("compounds: a vault share is worth more SPORE after harvest", async function () {
    // give alice SPORE to deposit
    await lp.connect(alice).approve(await farm.getAddress(), E(1000));
    await farm.connect(alice).deposit(1, E(100));
    await jump(DAY);
    await farm.connect(alice).withdraw(1, 0); // harvest only

    const bal = await spore.balanceOf(alice.address);
    expect(bal).to.be.gt(E(1000));

    await spore.connect(alice).approve(await vault.getAddress(), bal);
    await vault.connect(alice).deposit(E(1000));

    const ppsBefore = await vault.pricePerShare();
    await jump(DAY);
    await vault.connect(bob).harvest(); // anyone can call
    const ppsAfter = await vault.pricePerShare();

    expect(ppsAfter).to.be.gt(ppsBefore);
    expect(await spore.balanceOf(bob.address)).to.be.gt(0); // bob got the call bounty
    expect(await spore.balanceOf(treasury.address)).to.be.gt(0); // performance fee
  });

  it("locks minimum shares so the first depositor cannot inflate the share price", async function () {
    await lp.connect(alice).approve(await farm.getAddress(), E(1000));
    await farm.connect(alice).deposit(1, E(100));
    await jump(DAY);
    await farm.connect(alice).withdraw(1, 0);

    await spore.connect(alice).approve(await vault.getAddress(), E(1000));
    await vault.connect(alice).deposit(E(1000));

    const [shares] = await vault.userInfo(alice.address);
    expect(shares).to.equal(E(1000) - (await vault.MINIMUM_SHARES()));
    expect(await vault.totalShares()).to.equal(E(1000));
  });

  it("never pays rewards out of staked SPORE principal", async function () {
    await lp.connect(alice).approve(await farm.getAddress(), E(1000));
    await farm.connect(alice).deposit(1, E(100));
    await jump(DAY);
    await farm.connect(alice).withdraw(1, 0);

    const bal = await spore.balanceOf(alice.address);
    await spore.connect(alice).approve(await farm.getAddress(), bal);
    await farm.connect(alice).deposit(0, bal); // stake SPORE in pool 0

    const [staked] = await farm.users(0, alice.address);
    const farmBal = await spore.balanceOf(await farm.getAddress());
    expect(farmBal).to.be.gte(staked);
    expect(await farm.sporePid()).to.equal(0);

    await jump(DAY);
    await farm.connect(alice).withdraw(0, staked); // full exit must succeed
    expect(await spore.balanceOf(alice.address)).to.be.gt(bal);
  });

  it("stops minting at MAX_SUPPLY", async function () {
    expect(await spore.mintable()).to.equal(await spore.MAX_SUPPLY());
    await expect(spore.connect(alice).mint(alice.address, E(1))).to.be.reverted; // no role
  });

  it("keeps withdrawals open while paused", async function () {
    await lp.connect(alice).approve(await farm.getAddress(), E(1000));
    await farm.connect(alice).deposit(1, E(100));
    await jump(DAY);
    await farm.connect(alice).withdraw(1, 0);

    await spore.connect(alice).approve(await vault.getAddress(), E(1000));
    await vault.connect(alice).deposit(E(1000));

    await vault.pause();
    await expect(vault.connect(alice).deposit(E(1))).to.be.reverted;
    await expect(vault.connect(alice).withdrawAll()).to.not.be.reverted;
  });
});
