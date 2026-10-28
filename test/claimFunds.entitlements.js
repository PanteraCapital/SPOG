const { expect } = require("chai");
const { ethers } = require("hardhat");

// Vote codes stored by Round.vote. Type 0 is not a ballot; it is the empty slot.
const ABSTAIN = 1;
const UNINFORMED = 2;
const INFORMED = 3;

// 6 informed, 2 uninformed, 1 abstain.
// votesTotal = 8 and b = (8/2 - 2/8) * 6 / 8 = 3, so the stored entitlements are
// informedClaimable = b - 1 = 2 and uninformedClaimable = b = 3.
// tallyVotesFREE stores abstainedClaimable = b = 3.
// tallyVotesSPOG stores abstainedClaimable = b * 10**18 = 3e18 because v truncates to 0.
// Those values differ from the amounts claimFunds pays today (uninformed count 2,
// informed count 6, and 0 for an informed ballot).
const STORED = {
  tallyVotesFREE: { informed: 2n, uninformed: 3n, abstained: 3n },
  tallyVotesSPOG: { informed: 2n, uninformed: 3n, abstained: 3n * 10n ** 18n },
};

async function deployFundedRound(mintAmount) {
  const signers = await ethers.getSigners();
  const owner = signers[0];
  const token = await ethers.deployContract("ExperimentToken");
  await token.waitForDeployment();
  const round = await ethers.deployContract("Round", [await token.getAddress()]);
  await round.waitForDeployment();
  await token.mint(await round.getAddress(), mintAmount);
  return { signers, owner, token, round };
}

function voters(signers) {
  return {
    abstain: signers[1],
    uninformed: signers[2],
    informed: signers[4],
  };
}

async function castBallots(round, signers) {
  await round.connect(signers[1]).vote(ABSTAIN);
  await round.connect(signers[2]).vote(UNINFORMED);
  await round.connect(signers[3]).vote(UNINFORMED);
  for (let i = 4; i <= 9; i++) {
    await round.connect(signers[i]).vote(INFORMED);
  }
}

async function tally(round, method) {
  const tx = await round[method]();
  const receipt = await tx.wait();
  for (const log of receipt.logs) {
    let parsed;
    try {
      parsed = round.interface.parseLog(log);
    } catch {
      continue;
    }
    if (parsed && parsed.name === "VotesTallied") {
      return {
        informed: BigInt(parsed.args.informedClaimable),
        uninformed: BigInt(parsed.args.uninformedClaimable),
        abstained: BigInt(parsed.args.abstainedClaimable),
      };
    }
  }
  throw new Error("VotesTallied was not emitted");
}

async function freshAccounts(funder, count) {
  const accounts = [];
  for (let i = 0; i < count; i++) {
    const account = ethers.Wallet.createRandom().connect(ethers.provider);
    await funder.sendTransaction({
      to: account.address,
      value: ethers.parseEther("1"),
    });
    accounts.push(account);
  }
  return accounts;
}

async function paidOnce(round, token, account) {
  const roundAddress = await round.getAddress();
  const poolBefore = await token.balanceOf(roundAddress);
  const before = await token.balanceOf(account.address);
  await round.connect(account).claimFunds();
  const paid = (await token.balanceOf(account.address)) - before;
  const poolDelta = poolBefore - (await token.balanceOf(roundAddress));
  let withdrewOnce = false;
  try {
    await round.connect(account).claimFunds();
  } catch (err) {
    withdrewOnce = true;
    expect(err.message).to.include("can only withdraw once");
  }
  return { paid, poolDelta, withdrewOnce };
}

describe("claimFunds entitlements", function () {
  for (const method of ["tallyVotesSPOG", "tallyVotesFREE"]) {
    const stored = STORED[method];

    describe(method, function () {
      it("does not pay abstainedClaimable to addresses that never voted", async function () {
        const mintAmount = stored.abstained * 2n;
        const { signers, owner, token, round } = await deployFundedRound(mintAmount);
        await castBallots(round, signers);
        await round.closeRound();
        const entitlements = await tally(round, method);
        expect(entitlements.abstained).to.equal(stored.abstained);
        expect(entitlements.abstained).to.be.gt(0n);

        const attackers = await freshAccounts(owner, 2);
        const roundAddress = await round.getAddress();
        const paid = [];
        for (const attacker of attackers) {
          expect(await round.getVoterStatus(attacker.address)).to.equal(0n);
          const before = await token.balanceOf(attacker.address);
          try {
            await round.connect(attacker).claimFunds();
          } catch (err) {
            expect(err.message).to.include("did not vote");
          }
          paid.push(((await token.balanceOf(attacker.address)) - before).toString());
        }

        expect({
          paid,
          pool: (await token.balanceOf(roundAddress)).toString(),
        }).to.deep.equal({
          paid: ["0", "0"],
          pool: mintAmount.toString(),
        });
      });

      it("pays an abstain ballot abstainedClaimable from the round balance", async function () {
        const { signers, token, round } = await deployFundedRound(ethers.parseEther("1000"));
        const { abstain } = voters(signers);
        await castBallots(round, signers);
        await round.closeRound();
        const entitlements = await tally(round, method);
        expect(entitlements.abstained).to.equal(stored.abstained);
        expect(await round.getVoterStatus(abstain.address)).to.equal(BigInt(ABSTAIN));

        const result = await paidOnce(round, token, abstain);
        expect({
          paid: result.paid.toString(),
          poolDelta: result.poolDelta.toString(),
          withdrewOnce: result.withdrewOnce,
        }).to.deep.equal({
          paid: entitlements.abstained.toString(),
          poolDelta: entitlements.abstained.toString(),
          withdrewOnce: true,
        });
      });

      it("pays an uninformed ballot uninformedClaimable from the round balance", async function () {
        const { signers, token, round } = await deployFundedRound(ethers.parseEther("1000"));
        const { uninformed } = voters(signers);
        await castBallots(round, signers);
        await round.closeRound();
        const entitlements = await tally(round, method);
        expect(entitlements.uninformed).to.equal(stored.uninformed);
        expect(await round.getVoterStatus(uninformed.address)).to.equal(BigInt(UNINFORMED));

        const result = await paidOnce(round, token, uninformed);
        expect({
          paid: result.paid.toString(),
          poolDelta: result.poolDelta.toString(),
          withdrewOnce: result.withdrewOnce,
        }).to.deep.equal({
          paid: entitlements.uninformed.toString(),
          poolDelta: entitlements.uninformed.toString(),
          withdrewOnce: true,
        });
      });

      it("pays an informed ballot informedClaimable and records the withdrawal only for that payout", async function () {
        const { signers, token, round } = await deployFundedRound(ethers.parseEther("1000"));
        const { informed } = voters(signers);
        await castBallots(round, signers);
        await round.closeRound();
        const entitlements = await tally(round, method);
        expect(entitlements.informed).to.equal(stored.informed);
        expect(entitlements.informed).to.be.gt(0n);
        expect(await round.getVoterStatus(informed.address)).to.equal(BigInt(INFORMED));

        const result = await paidOnce(round, token, informed);
        expect({
          paid: result.paid.toString(),
          poolDelta: result.poolDelta.toString(),
          withdrewOnce: result.withdrewOnce,
        }).to.deep.equal({
          paid: entitlements.informed.toString(),
          poolDelta: entitlements.informed.toString(),
          withdrewOnce: true,
        });
      });

      it("does not consume the withdrawal when the informed entitlement is still zero", async function () {
        const { signers, token, round } = await deployFundedRound(ethers.parseEther("1000"));
        const { informed } = voters(signers);
        await castBallots(round, signers);
        await round.closeRound();
        expect(await round.getVoterStatus(informed.address)).to.equal(BigInt(INFORMED));

        try {
          await round.connect(informed).claimFunds();
        } catch (err) {
          expect(err.message).to.include("nothing to claim");
        }

        const entitlements = await tally(round, method);
        expect(entitlements.informed).to.equal(stored.informed);
        const result = await paidOnce(round, token, informed);
        expect({
          paid: result.paid.toString(),
          poolDelta: result.poolDelta.toString(),
          withdrewOnce: result.withdrewOnce,
        }).to.deep.equal({
          paid: entitlements.informed.toString(),
          poolDelta: entitlements.informed.toString(),
          withdrewOnce: true,
        });
      });
    });
  }
});
