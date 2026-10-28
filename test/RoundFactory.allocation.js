const { ethers, network } = require("hardhat");
const { expect } = require("chai");

// Spec for the createRound allocation bug.
//
// RoundFactory mints its own ExperimentToken into each new round, while Round
// stores the caller-supplied address and claimFunds transfers only that token.
// These tests require one asset to be both the credited allocation and the
// payout token:
//   - after createRound(token, amount), TOKEN_ADDRESS's balance of the round is amount
//   - if that token is not the factory's token, the round's factory-token balance is 0
//   - claimFunds then pays TOKEN_ADDRESS, including when the supplied token was
//     funded by a separate mint the way test/RoundFactory.js does
//
// Binding the round to the factory token and minting that token satisfies these
// tests. Minting the caller-supplied token also satisfies them when that mint
// succeeds and the factory token is not left on the round. The supplied tokens
// here are owned by the deployer, and ExperimentToken.mint is onlyOwner, so the
// factory cannot mint those tokens unless that ownership changes.
//
// Direct `new Round` is not covered. That path never mints an allocation.
// tallyVotesSPOG and tallyVotesFREE do not move tokens. claimFunds is the only
// transfer. Vote types 0 and 3 are not used as payees: type 0 reads
// abstainedClaimable (0 until a tally) and type 3 leaves the claim amount at 0,
// so neither moves value. Types 1 and 2 both reach the same transfer.

async function discoverFactoryToken(factory) {
  const receipt = await factory.deploymentTransaction().wait();
  const transferTopic = ethers.id("Transfer(address,address,uint256)");
  const addresses = [
    ...new Set(
      receipt.logs
        .filter((log) => log.topics[0] === transferTopic)
        .map((log) => ethers.getAddress(log.address))
    ),
  ];
  expect(addresses, "factory deployment should create one ExperimentToken").to.have.length(1);

  const token = await ethers.getContractAt("ExperimentToken", addresses[0]);
  expect(await token.name()).to.equal("Experiment");
  expect(await token.symbol()).to.equal("EXP");
  expect(await token.owner()).to.equal(await factory.getAddress());
  return token;
}

async function createRound(factory, signer, tokenAddress, amount) {
  const before = await factory.allRounds();
  await factory.connect(signer).createRound(tokenAddress, amount);
  const after = await factory.allRounds();
  expect(after.length).to.equal(before.length + 1);
  return ethers.getContractAt("Round", after[after.length - 1]);
}

async function closeAsOwner(round) {
  const roundOwner = await round.owner();
  await network.provider.send("hardhat_setBalance", [
    roundOwner,
    ethers.toQuantity(ethers.parseEther("1")),
  ]);
  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [roundOwner],
  });
  const signer = await ethers.getSigner(roundOwner);
  await round.connect(signer).closeRound();
  await network.provider.request({
    method: "hardhat_stopImpersonatingAccount",
    params: [roundOwner],
  });
}

async function payoutToken(round) {
  return ethers.getContractAt("ExperimentToken", await round.TOKEN_ADDRESS());
}

function sameAddress(left, right) {
  return ethers.getAddress(left) === ethers.getAddress(right);
}

async function expectAllocationHeldByPayoutToken(round, amount, factoryToken) {
  const payout = await payoutToken(round);
  const roundAddress = await round.getAddress();
  expect(await payout.balanceOf(roundAddress)).to.equal(amount);
  if (!sameAddress(await payout.getAddress(), await factoryToken.getAddress())) {
    expect(await factoryToken.balanceOf(roundAddress)).to.equal(0n);
  }
  return payout;
}

describe("RoundFactory allocation token", function () {
  let owner;
  let voterAbstain;
  let voterUninformed;
  let voterInformed;
  let supplied;
  let otherSupplied;
  let factory;
  let factoryToken;

  beforeEach(async function () {
    [owner, voterAbstain, voterUninformed, voterInformed] = await ethers.getSigners();

    const ExperimentToken = await ethers.getContractFactory("ExperimentToken");
    supplied = await ExperimentToken.deploy();
    await supplied.waitForDeployment();
    otherSupplied = await ExperimentToken.deploy();
    await otherSupplied.waitForDeployment();

    const RoundFactory = await ethers.getContractFactory("RoundFactory");
    factory = await RoundFactory.deploy();
    await factory.waitForDeployment();
    factoryToken = await discoverFactoryToken(factory);
  });

  it("credits a round with the factory token when that is the address passed in", async function () {
    const amount = 1000n;
    const round = await createRound(factory, owner, await factoryToken.getAddress(), amount);
    await expectAllocationHeldByPayoutToken(round, amount, factoryToken);
    expect(sameAddress(await round.TOKEN_ADDRESS(), await factoryToken.getAddress())).to.equal(true);
  });

  it("credits the payout token when createRound is given a different token", async function () {
    const amount = 1000n;
    expect(sameAddress(await supplied.getAddress(), await factoryToken.getAddress())).to.equal(false);

    const round = await createRound(factory, owner, await supplied.getAddress(), amount);

    await expectAllocationHeldByPayoutToken(round, amount, factoryToken);
  });

  it("credits every createRound call, including a second token and amount", async function () {
    const firstAmount = 1000n;
    const secondAmount = 2500n;
    const first = await createRound(factory, owner, await supplied.getAddress(), firstAmount);
    const second = await createRound(
      factory,
      owner,
      await otherSupplied.getAddress(),
      secondAmount
    );

    await expectAllocationHeldByPayoutToken(first, firstAmount, factoryToken);
    await expectAllocationHeldByPayoutToken(second, secondAmount, factoryToken);

    // The second mint must not move or replace the first round's allocation.
    await expectAllocationHeldByPayoutToken(first, firstAmount, factoryToken);
  });

  it("pays claimFunds from the token createRound credited", async function () {
    const amount = 1000n;
    const round = await createRound(factory, owner, await supplied.getAddress(), amount);
    const payout = await payoutToken(round);

    await round.connect(voterAbstain).vote(1);
    await round.connect(voterUninformed).vote(2);
    await round.connect(voterInformed).vote(3);
    await closeAsOwner(round);

    const roundAddress = await round.getAddress();
    const factoryAddress = await factoryToken.getAddress();

    async function claim(voter) {
      const payoutBeforeVoter = await payout.balanceOf(voter.address);
      const payoutBeforeRound = await payout.balanceOf(roundAddress);
      const factoryBeforeVoter = await factoryToken.balanceOf(voter.address);
      const factoryBeforeRound = await factoryToken.balanceOf(roundAddress);

      const tx = await round.connect(voter).claimFunds();
      const receipt = await tx.wait();
      const paid = receipt.logs
        .map((log) => {
          try {
            return round.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((parsed) => parsed && parsed.name === "BitRefundReceived");
      expect(paid, "BitRefundReceived").to.not.equal(undefined);
      const claimed = paid.args[1];
      expect(claimed).to.be.greaterThan(0n);

      expect(await payout.balanceOf(voter.address) - payoutBeforeVoter).to.equal(claimed);
      expect(payoutBeforeRound - (await payout.balanceOf(roundAddress))).to.equal(claimed);

      if (!sameAddress(await payout.getAddress(), factoryAddress)) {
        expect(await factoryToken.balanceOf(voter.address)).to.equal(factoryBeforeVoter);
        expect(await factoryToken.balanceOf(roundAddress)).to.equal(0n);
        expect(factoryBeforeRound).to.equal(0n);
      }
      return claimed;
    }

    let claimedTotal = 0n;
    claimedTotal += await claim(voterAbstain);
    claimedTotal += await claim(voterUninformed);

    // Both positive claims come out of the allocation, which remains on the payout token.
    expect(await payout.balanceOf(roundAddress)).to.equal(amount - claimedTotal);
    if (!sameAddress(await payout.getAddress(), factoryAddress)) {
      expect(await factoryToken.balanceOf(roundAddress)).to.equal(0n);
    }
  });

  it("still pays the createRound allocation when the supplied token is minted separately", async function () {
    const allocation = 1000n;
    const separateMint = 7n;
    const round = await createRound(factory, owner, await supplied.getAddress(), allocation);
    const roundAddress = await round.getAddress();

    // test/RoundFactory.js funds the caller-supplied token after createRound.
    await supplied.connect(owner).mint(roundAddress, separateMint);

    await round.connect(voterAbstain).vote(1);
    await round.connect(voterUninformed).vote(2);
    await closeAsOwner(round);

    const payout = await payoutToken(round);
    const voterBefore = await payout.balanceOf(voterAbstain.address);
    const roundPayoutBefore = await payout.balanceOf(roundAddress);

    const tx = await round.connect(voterAbstain).claimFunds();
    const receipt = await tx.wait();
    const paid = receipt.logs
      .map((log) => {
        try {
          return round.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed) => parsed && parsed.name === "BitRefundReceived");
    const claimed = paid.args[1];
    expect(claimed).to.be.greaterThan(0n);
    expect(await payout.balanceOf(voterAbstain.address) - voterBefore).to.equal(claimed);
    expect(roundPayoutBefore - (await payout.balanceOf(roundAddress))).to.equal(claimed);

    if (!sameAddress(await payout.getAddress(), await factoryToken.getAddress())) {
      expect(await factoryToken.balanceOf(roundAddress)).to.equal(0n);
      expect(await factoryToken.balanceOf(voterAbstain.address)).to.equal(0n);
    } else {
      // The separate mint is a different asset and must not be what was paid.
      expect(await supplied.balanceOf(voterAbstain.address)).to.equal(0n);
      expect(await supplied.balanceOf(roundAddress)).to.equal(separateMint);
    }
  });
});
