const { expect } = require("chai");

// Spec for factory-created rounds. These tests fail until the account
// authorized by RoundFactory.createRound is the owner of the Round that
// call created. While the factory contract itself is the owner, nobody can
// close that round, tally it, or transfer it, and claimFunds cannot pay.
//
// Vote codes in Round.vote: 1 abstain, 2 uninformed, 3 informed.
// claimFunds pays votesUninformed to abstain voters, votesInformed to
// uninformed voters, and abstainedClaimable to addresses that did not vote.
// Informed voters are not assigned a claim amount by claimFunds.

async function deployActors() {
  const [
    deployer,
    organizer,
    informedA,
    informedB,
    uninformed,
    abstain,
    nonVoter,
    successor,
    stranger,
  ] = await ethers.getSigners();

  const ExperimentToken = await ethers.getContractFactory("ExperimentToken");
  const externalToken = await ExperimentToken.connect(organizer).deploy();
  await externalToken.waitForDeployment();

  const RoundFactory = await ethers.getContractFactory("RoundFactory");
  const factory = await RoundFactory.connect(deployer).deploy();
  await factory.waitForDeployment();
  await factory.connect(deployer).transferOwnership(organizer.address);

  // RoundFactory.exp is internal, so the allocation token is the contract
  // that emitted Transfer while the factory was constructed.
  const transferTopic = ethers.id("Transfer(address,address,uint256)");
  const factoryAddress = (await factory.getAddress()).toLowerCase();
  const deployment = await factory.deploymentTransaction().wait();
  const tokenLogs = deployment.logs.filter(
    (log) => log.address.toLowerCase() !== factoryAddress && log.topics[0] === transferTopic
  );
  expect(tokenLogs).to.have.lengthOf(1);
  const factoryToken = await ethers.getContractAt("ExperimentToken", tokenLogs[0].address);

  return {
    deployer,
    organizer,
    informedA,
    informedB,
    uninformed,
    abstain,
    nonVoter,
    successor,
    stranger,
    externalToken,
    factory,
    factoryToken,
  };
}

async function roundFromCreate(factory, tx) {
  const receipt = await tx.wait();
  const created = [];
  for (const log of receipt.logs) {
    try {
      const parsed = factory.interface.parseLog(log);
      if (parsed && parsed.name === "RoundCreated") {
        created.push(parsed.args[0]);
      }
    } catch {
      // Round also emits RoundCreated(bool); that log is not this event.
    }
  }
  expect(created).to.have.lengthOf(1);
  const roundAddress = created[0];
  const listed = (await factory.allRounds()).map((address) => address.toLowerCase());
  expect(listed).to.include(roundAddress.toLowerCase());
  return ethers.getContractAt("Round", roundAddress);
}

async function createRound(factory, organizer, tokenAddress, mintAmount) {
  const tx = await factory.connect(organizer).createRound(tokenAddress, mintAmount);
  const round = await roundFromCreate(factory, tx);
  expect(await round.TOKEN_ADDRESS()).to.equal(tokenAddress);
  return round;
}

// createRound authorized `organizer`. Move the factory's own owner away
// before any later round call so a fix that looks the owner up again on
// the factory, or that acts on some other round, cannot satisfy the test.
async function handFactoryToStranger(ctx) {
  await ctx.factory.connect(ctx.organizer).transferOwnership(ctx.stranger.address);
  expect(await ctx.factory.owner()).to.equal(ctx.stranger.address);
}

async function castInformedPair(round, informedA, informedB) {
  await round.connect(informedA).vote(3);
  await round.connect(informedB).vote(3);
  expect(await round.getVoterStatus(informedA.address)).to.equal(3n);
  expect(await round.getVoterStatus(informedB.address)).to.equal(3n);
}

describe("factory-created round release", function () {
  it("assigns each created round to the account createRound authorized", async function () {
    const ctx = await deployActors();
    const { factory, organizer, factoryToken, stranger } = ctx;
    const tokenAddress = await factoryToken.getAddress();

    const first = await createRound(factory, organizer, tokenAddress, 25n);
    const second = await createRound(factory, organizer, tokenAddress, 40n);
    await handFactoryToStranger(ctx);

    expect(await first.getAddress()).to.not.equal(await second.getAddress());
    expect(await first.owner()).to.equal(organizer.address);
    expect(await second.owner()).to.equal(organizer.address);
    expect(await first.owner()).to.not.equal(await factory.getAddress());
    expect(await factoryToken.balanceOf(await first.getAddress())).to.equal(25n);
    expect(await factoryToken.balanceOf(await second.getAddress())).to.equal(40n);

    await expect(first.connect(stranger).closeRound()).to.be.revertedWithCustomError(
      first,
      "OwnableUnauthorizedAccount"
    ).withArgs(stranger.address);
    await first.connect(organizer).closeRound();
    expect(await first.getRoundStatus()).to.equal(true);
    expect(await second.getRoundStatus()).to.equal(false);
    expect(await second.owner()).to.equal(organizer.address);
  });

  it("lets that organizer close only the round createRound deployed for them", async function () {
    const ctx = await deployActors();
    const { factory, organizer, factoryToken, stranger } = ctx;
    const tokenAddress = await factoryToken.getAddress();
    const round = await createRound(factory, organizer, tokenAddress, 10n);
    const other = await createRound(factory, organizer, tokenAddress, 10n);
    await handFactoryToStranger(ctx);

    expect(await round.getRoundStatus()).to.equal(false);
    await expect(round.connect(stranger).closeRound())
      .to.be.revertedWithCustomError(round, "OwnableUnauthorizedAccount")
      .withArgs(stranger.address);

    await expect(round.connect(organizer).closeRound())
      .to.emit(round, "RoundEnded")
      .withArgs(true);
    expect(await round.owner()).to.equal(organizer.address);
    expect(await round.getRoundStatus()).to.equal(true);
    expect(await other.getRoundStatus()).to.equal(false);
    expect(await other.owner()).to.equal(organizer.address);
  });

  it("lets that organizer tally SPOG votes on the round createRound deployed", async function () {
    const ctx = await deployActors();
    const { factory, organizer, informedA, informedB, factoryToken, stranger } = ctx;
    const tokenAddress = await factoryToken.getAddress();
    const round = await createRound(factory, organizer, tokenAddress, 10n);
    await castInformedPair(round, informedA, informedB);
    await handFactoryToStranger(ctx);

    await expect(round.connect(stranger).tallyVotesSPOG())
      .to.be.revertedWithCustomError(round, "OwnableUnauthorizedAccount")
      .withArgs(stranger.address);

    await round.connect(organizer).closeRound();
    await expect(round.connect(organizer).tallyVotesSPOG())
      .to.emit(round, "VotesTallied")
      .withArgs(0n, 1n, 10n ** 18n);
    expect(await round.owner()).to.equal(organizer.address);
  });

  it("lets that organizer tally FREE votes on the round createRound deployed", async function () {
    const ctx = await deployActors();
    const { factory, organizer, informedA, informedB, factoryToken, stranger } = ctx;
    const tokenAddress = await factoryToken.getAddress();
    const round = await createRound(factory, organizer, tokenAddress, 10n);
    await castInformedPair(round, informedA, informedB);
    await handFactoryToStranger(ctx);

    await expect(round.connect(stranger).tallyVotesFREE())
      .to.be.revertedWithCustomError(round, "OwnableUnauthorizedAccount")
      .withArgs(stranger.address);

    await round.connect(organizer).closeRound();
    await expect(round.connect(organizer).tallyVotesFREE())
      .to.emit(round, "VotesTallied")
      .withArgs(0n, 1n, 1n);
    expect(await round.owner()).to.equal(organizer.address);
  });

  it("pays voters from the allocation minted to the round createRound deployed", async function () {
    const ctx = await deployActors();
    const { factory, organizer, informedA, informedB, uninformed, abstain, factoryToken, stranger } = ctx;
    const tokenAddress = await factoryToken.getAddress();
    const mintAmount = 100n;
    const round = await createRound(factory, organizer, tokenAddress, mintAmount);
    const roundAddress = await round.getAddress();

    await round.connect(informedA).vote(3);
    await round.connect(informedB).vote(3);
    await round.connect(uninformed).vote(2);
    await round.connect(abstain).vote(1);
    expect(await factoryToken.balanceOf(roundAddress)).to.equal(mintAmount);

    await expect(round.connect(uninformed).claimFunds()).to.be.revertedWith("round is still open");
    await handFactoryToStranger(ctx);

    await expect(round.connect(stranger).closeRound())
      .to.be.revertedWithCustomError(round, "OwnableUnauthorizedAccount")
      .withArgs(stranger.address);
    await expect(round.connect(stranger).tallyVotesFREE())
      .to.be.revertedWithCustomError(round, "OwnableUnauthorizedAccount")
      .withArgs(stranger.address);

    await round.connect(organizer).closeRound();
    await expect(round.connect(organizer).tallyVotesFREE())
      .to.emit(round, "VotesTallied")
      .withArgs(0n, 0n, 0n);

    const uninformedBefore = await factoryToken.balanceOf(uninformed.address);
    const abstainBefore = await factoryToken.balanceOf(abstain.address);
    await expect(round.connect(uninformed).claimFunds())
      .to.emit(round, "BitRefundReceived")
      .withArgs(uninformed.address, 2n);
    await expect(round.connect(abstain).claimFunds())
      .to.emit(round, "BitRefundReceived")
      .withArgs(abstain.address, 1n);

    expect(await factoryToken.balanceOf(uninformed.address) - uninformedBefore).to.equal(2n);
    expect(await factoryToken.balanceOf(abstain.address) - abstainBefore).to.equal(1n);
    expect(await factoryToken.balanceOf(roundAddress)).to.equal(mintAmount - 3n);
    await expect(round.connect(uninformed).claimFunds()).to.be.revertedWith("can only withdraw once");
    expect(await round.owner()).to.equal(organizer.address);
  });

  it("pays a claimant from tokens sent to the round createRound deployed", async function () {
    const ctx = await deployActors();
    const { factory, organizer, informedA, informedB, nonVoter, externalToken, stranger } = ctx;
    const tokenAddress = await externalToken.getAddress();
    const sent = 10n ** 18n;
    const round = await createRound(factory, organizer, tokenAddress, 0n);
    const roundAddress = await round.getAddress();

    await externalToken.connect(organizer).mint(organizer.address, sent);
    await externalToken.connect(organizer).transfer(roundAddress, sent);
    expect(await externalToken.balanceOf(roundAddress)).to.equal(sent);
    expect(await externalToken.balanceOf(organizer.address)).to.equal(0n);

    await castInformedPair(round, informedA, informedB);
    await expect(round.connect(nonVoter).claimFunds()).to.be.revertedWith("round is still open");
    await handFactoryToStranger(ctx);

    await round.connect(organizer).closeRound();
    await expect(round.connect(organizer).tallyVotesSPOG())
      .to.emit(round, "VotesTallied")
      .withArgs(0n, 1n, sent);

    const before = await externalToken.balanceOf(nonVoter.address);
    await expect(round.connect(nonVoter).claimFunds())
      .to.emit(round, "BitRefundReceived")
      .withArgs(nonVoter.address, sent);
    expect(await externalToken.balanceOf(nonVoter.address) - before).to.equal(sent);
    expect(await externalToken.balanceOf(roundAddress)).to.equal(0n);
    await expect(round.connect(nonVoter).claimFunds()).to.be.revertedWith("can only withdraw once");
    expect(await round.owner()).to.equal(organizer.address);
  });

  it("lets that organizer transfer ownership of the round createRound deployed", async function () {
    const ctx = await deployActors();
    const { factory, organizer, successor, factoryToken, stranger } = ctx;
    const tokenAddress = await factoryToken.getAddress();
    const round = await createRound(factory, organizer, tokenAddress, 10n);
    const other = await createRound(factory, organizer, tokenAddress, 10n);
    await handFactoryToStranger(ctx);

    await expect(round.connect(stranger).transferOwnership(stranger.address))
      .to.be.revertedWithCustomError(round, "OwnableUnauthorizedAccount")
      .withArgs(stranger.address);

    await expect(round.connect(organizer).transferOwnership(successor.address))
      .to.emit(round, "OwnershipTransferred")
      .withArgs(organizer.address, successor.address);
    expect(await round.owner()).to.equal(successor.address);
    expect(await other.owner()).to.equal(organizer.address);

    await expect(round.connect(organizer).closeRound())
      .to.be.revertedWithCustomError(round, "OwnableUnauthorizedAccount")
      .withArgs(organizer.address);
    await round.connect(successor).closeRound();
    expect(await round.getRoundStatus()).to.equal(true);
    expect(await other.getRoundStatus()).to.equal(false);
  });

  it("lets that organizer renounce ownership of the round createRound deployed", async function () {
    const ctx = await deployActors();
    const { factory, organizer, factoryToken, stranger } = ctx;
    const tokenAddress = await factoryToken.getAddress();
    const round = await createRound(factory, organizer, tokenAddress, 10n);
    const other = await createRound(factory, organizer, tokenAddress, 10n);
    await handFactoryToStranger(ctx);

    await expect(round.connect(stranger).renounceOwnership())
      .to.be.revertedWithCustomError(round, "OwnableUnauthorizedAccount")
      .withArgs(stranger.address);

    await expect(round.connect(organizer).renounceOwnership())
      .to.emit(round, "OwnershipTransferred")
      .withArgs(organizer.address, ethers.ZeroAddress);
    expect(await round.owner()).to.equal(ethers.ZeroAddress);
    await expect(round.connect(organizer).closeRound())
      .to.be.revertedWithCustomError(round, "OwnableUnauthorizedAccount")
      .withArgs(organizer.address);
    expect(await other.owner()).to.equal(organizer.address);
    expect(await other.getRoundStatus()).to.equal(false);
  });
});
