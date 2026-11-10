const { expect } = require("chai");
const { ethers } = require("hardhat");

async function jump(seconds) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine");
}

describe("Testnet mocks", function () {
  let alice, bob;
  let usdc, wbtc, faucet;

  beforeEach(async function () {
    [alice, bob] = await ethers.getSigners();
    const T = await ethers.getContractFactory("TestToken");
    usdc = await T.deploy("Test USD Coin", "tUSDC", 6);
    wbtc = await T.deploy("Test Wrapped BTC", "tWBTC", 8);

    const F = await ethers.getContractFactory("Faucet");
    faucet = await F.deploy(
      [await usdc.getAddress(), await wbtc.getAddress()],
      [ethers.parseUnits("5000", 6), ethers.parseUnits("2", 8)]
    );
  });

  it("honours each token's own decimals", async function () {
    expect(await usdc.decimals()).to.equal(6);
    expect(await wbtc.decimals()).to.equal(8);
  });

  it("drips every token in one call", async function () {
    await faucet.connect(bob).drip();
    expect(await usdc.balanceOf(bob.address)).to.equal(ethers.parseUnits("5000", 6));
    expect(await wbtc.balanceOf(bob.address)).to.equal(ethers.parseUnits("2", 8));
  });

  it("rate-limits a wallet to one drip per hour", async function () {
    await faucet.connect(bob).drip();
    await expect(faucet.connect(bob).drip()).to.be.revertedWithCustomError(faucet, "TooSoon");

    await jump(3601);
    await faucet.connect(bob).drip();
    expect(await usdc.balanceOf(bob.address)).to.equal(ethers.parseUnits("10000", 6));
  });

  it("does not make one wallet's cooldown block another", async function () {
    await faucet.connect(bob).drip();
    await faucet.connect(alice).drip();
    expect(await usdc.balanceOf(alice.address)).to.equal(ethers.parseUnits("5000", 6));
  });

  it("caps a single mint so one call cannot flood a pool", async function () {
    const tooMuch = ethers.parseUnits("1000001", 6);
    await expect(usdc.mint(alice.address, tooMuch)).to.be.revertedWithCustomError(usdc, "MintTooLarge");
  });
});
