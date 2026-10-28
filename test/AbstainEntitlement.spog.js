const { expect } = require("chai");

/**
 * Spec for the costly-abstention entitlement.
 *
 * tallyVotesSPOG already computes an integer base b and penalty v and stores
 * the informed and uninformed entitlements in that unit. The abstain
 * entitlement must be max(0, b - v) in that same unit. claimFunds must
 * transfer that amount on the branch that pays abstainedClaimable
 * (an address that has not voted). These tests fail while abstain is stored
 * and paid as b * 10^18 - v.
 */

function integerEntitlements(informedVotes, uninformedVotes) {
  const n = informedVotes + uninformedVotes;
  const b = Math.trunc((Math.trunc(n / 2) - Math.trunc(uninformedVotes / n)) * informedVotes / n);
  const v = Math.trunc((n - 1) / (n * n)) + Math.trunc(1 / n);
  return {
    b,
    v,
    informedClaimable: b > 1 ? b - 1 : 0,
    uninformedClaimable: b > 0 ? b : 0,
    abstainedClaimable: b - v > 0 ? b - v : 0,
  };
}

async function deployRound() {
  const signers = await ethers.getSigners();
  const owner = signers[0];
  const ExperimentToken = await ethers.getContractFactory("ExperimentToken");
  const token = await ExperimentToken.deploy();
  await token.waitForDeployment();
  const Round = await ethers.getContractFactory("Round");
  const round = await Round.connect(owner).deploy(await token.getAddress());
  await round.waitForDeployment();
  return { signers, owner, token, round };
}

async function castVotes(round, ballots) {
  for (const ballot of ballots) {
    await round.connect(ballot.signer).vote(ballot.voteType);
  }
}

describe("SPOG abstain entitlement", function () {
  const shapes = [
    {
      name: "repository tally shape (b = 1)",
      // Same ballots as test/Round.js "should tally votes as expected":
      // 3 abstain, 2 uninformed, 2 informed. Abstain votes do not enter b.
      ballots(signers) {
        return [
          { signer: signers[1], voteType: 1 },
          { signer: signers[2], voteType: 1 },
          { signer: signers[3], voteType: 1 },
          { signer: signers[4], voteType: 2 },
          { signer: signers[5], voteType: 2 },
          { signer: signers[6], voteType: 3 },
          { signer: signers[7], voteType: 3 },
        ];
      },
      informedVotes: 2,
      uninformedVotes: 2,
      nonVoterIndexes: [8, 9],
      uninformedClaimantIndex: 4,
    },
    {
      name: "integer base above 1 (b = 2)",
      // n = 7, u = 1, i = 6 -> b = (7/2 - 1/7) * 6 / 7 = 2, v = 0.
      ballots(signers) {
        const ballots = [{ signer: signers[1], voteType: 2 }];
        for (let i = 2; i <= 7; i++) {
          ballots.push({ signer: signers[i], voteType: 3 });
        }
        return ballots;
      },
      informedVotes: 6,
      uninformedVotes: 1,
      nonVoterIndexes: [8, 9],
      uninformedClaimantIndex: 1,
    },
  ];

  for (const shape of shapes) {
    describe(shape.name, function () {
      const expected = integerEntitlements(shape.informedVotes, shape.uninformedVotes);

      let owner, token, round, signers;

      beforeEach(async function () {
        ({ signers, owner, token, round } = await deployRound());
        await castVotes(round, shape.ballots(signers));
        await round.connect(owner).closeRound();
      });

      it("stores abstain in the same unit as the informed and uninformed entitlements", async function () {
        expect(expected.b).to.be.at.least(1);
        expect(expected.abstainedClaimable).to.equal(Math.max(0, expected.b - expected.v));
        expect(expected.uninformedClaimable).to.equal(expected.b > 0 ? expected.b : 0);

        await expect(round.connect(owner).tallyVotesSPOG())
          .to.emit(round, "VotesTallied")
          .withArgs(
            expected.informedClaimable,
            expected.uninformedClaimable,
            expected.abstainedClaimable
          );
      });

      it("pays the same-unit abstain entitlement to a caller with no vote", async function () {
        const decimals = await token.decimals();
        const oneToken = 10n ** BigInt(decimals);
        // Enough that one inflated claim of about b whole tokens succeeds,
        // and a second such claim does not.
        const surplus = 1000n;
        const funded = BigInt(expected.b) * oneToken + surplus;
        await token.mint(await round.getAddress(), funded);
        await round.connect(owner).tallyVotesSPOG();

        const claimant = signers[shape.nonVoterIndexes[0]];
        const roundAddress = await round.getAddress();
        const beforeClaimant = await token.balanceOf(claimant.address);
        const beforeRound = await token.balanceOf(roundAddress);

        await expect(round.connect(claimant).claimFunds())
          .to.emit(round, "BitRefundReceived")
          .withArgs(claimant.address, expected.abstainedClaimable);

        const paid = (await token.balanceOf(claimant.address)) - beforeClaimant;
        expect(paid).to.equal(BigInt(expected.abstainedClaimable));
        expect(paid).to.be.lt(oneToken);
        expect(beforeRound - (await token.balanceOf(roundAddress))).to.equal(paid);
      });

      it("lets every abstain-entitlement claim succeed on a round funded with b whole tokens", async function () {
        const decimals = await token.decimals();
        const oneToken = 10n ** BigInt(decimals);
        const surplus = 1000n;
        const funded = BigInt(expected.b) * oneToken + surplus;
        await token.mint(await round.getAddress(), funded);
        await round.connect(owner).tallyVotesSPOG();

        const roundAddress = await round.getAddress();
        let spent = 0n;
        for (const index of shape.nonVoterIndexes) {
          const claimant = signers[index];
          const before = await token.balanceOf(claimant.address);
          await round.connect(claimant).claimFunds();
          const paid = (await token.balanceOf(claimant.address)) - before;
          expect(paid).to.equal(BigInt(expected.abstainedClaimable));
          spent += paid;
        }

        // A voter on a different claim branch can still be paid from what remains.
        const other = signers[shape.uninformedClaimantIndex];
        const otherBefore = await token.balanceOf(other.address);
        await round.connect(other).claimFunds();
        const otherPaid = (await token.balanceOf(other.address)) - otherBefore;
        expect(otherPaid).to.equal(BigInt(shape.informedVotes));
        spent += otherPaid;

        expect(await token.balanceOf(roundAddress)).to.equal(funded - spent);
        expect(spent).to.be.lt(oneToken);
      });

      it("pays the same-unit abstain entitlement when the round holds only a same-unit budget", async function () {
        const budget = 1000n;
        expect(BigInt(expected.abstainedClaimable)).to.be.lt(budget);
        await token.mint(await round.getAddress(), budget);
        await round.connect(owner).tallyVotesSPOG();

        const claimant = signers[shape.nonVoterIndexes[0]];
        const roundAddress = await round.getAddress();
        await round.connect(claimant).claimFunds();

        expect(await token.balanceOf(claimant.address)).to.equal(BigInt(expected.abstainedClaimable));
        expect(await token.balanceOf(roundAddress)).to.equal(budget - BigInt(expected.abstainedClaimable));
      });
    });
  }
});
