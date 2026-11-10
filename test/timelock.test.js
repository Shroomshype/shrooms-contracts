const { expect } = require("chai");
const { ethers } = require("hardhat");

const E = (n) => ethers.parseEther(String(n));

async function jump(seconds) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine");
}

describe("Timelock governance", function () {
  let owner, proposer, stranger, treasury;
  let spore, farm, timelock;
  const DELAY = 3600;

  beforeEach(async function () {
    [owner, proposer, stranger, treasury] = await ethers.getSigners();

    spore = await (await ethers.getContractFactory("SporeToken")).deploy(owner.address);
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    farm = await (await ethers.getContractFactory("SporeFarm")).deploy(
      await spore.getAddress(), E(0.1), now, treasury.address, owner.address
    );
    await spore.grantRole(await spore.MINTER_ROLE(), await farm.getAddress());

    timelock = await (await ethers.getContractFactory("ShroomsTimelock")).deploy(
      DELAY, [proposer.address], [ethers.ZeroAddress], ethers.ZeroAddress
    );

    // Ownable2Step handover
    await farm.transferOwnership(await timelock.getAddress());
    const data = farm.interface.encodeFunctionData("acceptOwnership", []);
    const salt = ethers.ZeroHash;
    await timelock.connect(proposer).schedule(
      await farm.getAddress(), 0, data, ethers.ZeroHash, salt, DELAY
    );
    await jump(DELAY + 1);
    await timelock.connect(stranger).execute(
      await farm.getAddress(), 0, data, ethers.ZeroHash, salt
    );
  });

  it("hands the farm to the timelock", async function () {
    expect(await farm.owner()).to.equal(await timelock.getAddress());
  });

  it("locks out the old owner entirely", async function () {
    await expect(farm.connect(owner).setEmission(E(0.2)))
      .to.be.revertedWithCustomError(farm, "OwnableUnauthorizedAccount");
  });

  it("refuses to execute a parameter change before the delay elapses", async function () {
    const data = farm.interface.encodeFunctionData("setEmission", [E(0.05)]);
    const salt = ethers.id("emission-cut");
    await timelock.connect(proposer).schedule(
      await farm.getAddress(), 0, data, ethers.ZeroHash, salt, DELAY
    );
    await expect(
      timelock.connect(stranger).execute(await farm.getAddress(), 0, data, ethers.ZeroHash, salt)
    ).to.be.reverted;

    await jump(DELAY + 1);
    await timelock.connect(stranger).execute(await farm.getAddress(), 0, data, ethers.ZeroHash, salt);
    expect(await farm.emissionPerSecond()).to.equal(E(0.05));
  });

  it("lets anyone execute once the delay has passed", async function () {
    const data = farm.interface.encodeFunctionData("setEmission", [E(0.08)]);
    const salt = ethers.id("anyone-executes");
    await timelock.connect(proposer).schedule(
      await farm.getAddress(), 0, data, ethers.ZeroHash, salt, DELAY
    );
    await jump(DELAY + 1);
    // stranger holds no role at all — executors is address(0), meaning open
    await timelock.connect(stranger).execute(await farm.getAddress(), 0, data, ethers.ZeroHash, salt);
    expect(await farm.emissionPerSecond()).to.equal(E(0.08));
  });

  it("will not let a non-proposer queue anything", async function () {
    const data = farm.interface.encodeFunctionData("setEmission", [E(1)]);
    await expect(
      timelock.connect(stranger).schedule(
        await farm.getAddress(), 0, data, ethers.ZeroHash, ethers.id("nope"), DELAY
      )
    ).to.be.reverted;
  });

  it("still cannot exceed the hard emission cap, even through governance", async function () {
    const data = farm.interface.encodeFunctionData("setEmission", [E(2)]);
    const salt = ethers.id("firehose");
    await timelock.connect(proposer).schedule(
      await farm.getAddress(), 0, data, ethers.ZeroHash, salt, DELAY
    );
    await jump(DELAY + 1);
    await expect(
      timelock.connect(stranger).execute(await farm.getAddress(), 0, data, ethers.ZeroHash, salt)
    ).to.be.reverted;
  });
});
