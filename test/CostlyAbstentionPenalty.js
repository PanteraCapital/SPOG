const { expect } = require("chai");
const { ethers } = require("hardhat");

// 60.18 fixed-point unit used by the published payout formulas and by
// @prb/math 4.0.1 UD60x18 (UNIT = 1e18). Division rounds toward zero, matching
// Common.mulDiv / UD60x18 div and mul.
const UNIT = 10n ** 18n;
const PENALTY_CAP = (3n * UNIT) / 10n; // 0.3

const VOTE_ABSTAIN = 1;
const VOTE_UNINFORMED = 2;
const VOTE_INFORMED = 3;

function w(count) {
  return BigInt(count) * UNIT;
}

// floor(x * y / d), toward zero, for the non-negative products used here.
function mulDiv(x, y, d) {
  return (x * y) / d;
}

function wMul(x, y) {
  return mulDiv(x, y, UNIT);
}

function wDiv(x, y) {
  return mulDiv(x, UNIT, y);
}

/**
 * Published formulas (frontend/web/views/pages/spog.html):
 *   b = ((n/2 - u/n) * i) / n
 *   v = min(0.3, (n-1)/n^2 + 1/n)   // costly abstention only
 *   informed    = max(0, b - 1)
 *   uninformed  = max(0, b)
 *   abstain     = max(0, b - v)      // v = 0 when abstention is free
 * n, i, and u count informed and uninformed votes only. Results are wei
 * (1 token = 1e18), the unit ExperimentToken uses and the unit the page's
 * claimable display divides by.
 *
 * Arithmetic follows UD60x18 operator order: each / is mulDiv(x, 1e18, y)
 * and each * is mulDiv(x, y, 1e18). When u/n > n/2 the difference is taken
 * as 0 because i is then 0 and the real product is 0 (UD60x18 subtraction
 * would otherwise underflow).
 */
function publishedPayouts(informedCount, uninformedCount, costly) {
  const n = BigInt(informedCount + uninformedCount);
  const nW = w(n);
  const iW = w(informedCount);
  const uW = w(uninformedCount);
  const one = w(1);
  const two = w(2);

  const half = wDiv(nW, two);
  const uninformedShare = wDiv(uW, nW);
  const quality = half > uninformedShare ? half - uninformedShare : 0n;
  const base = wDiv(wMul(quality, iW), nW);

  let penalty = 0n;
  if (costly) {
    const raw = wDiv(nW - one, wMul(nW, nW)) + wDiv(one, nW);
    penalty = raw < PENALTY_CAP ? raw : PENALTY_CAP;
  }

  const informed = base > one ? base - one : 0n;
  const uninformed = base;
  const abstain = base > penalty ? base - penalty : 0n;
  return { base, penalty, informed, uninformed, abstain };
}

async function deployFundedRound() {
  const signers = await ethers.getSigners();
  const owner = signers[0];
  const token = await ethers.deployContract("ExperimentToken");
  await token.waitForDeployment();
  const round = await ethers.deployContract("Round", [await token.getAddress()]);
  await round.waitForDeployment();
  await token.mint(await round.getAddress(), w(1_000_000));
  return { owner, token, round, signers };
}

async function castVotes(round, ballots) {
  for (const ballot of ballots) {
    await round.connect(ballot.signer).vote(ballot.kind);
  }
}

async function expectClaim(token, round, signer, amount) {
  const roundAddress = await round.getAddress();
  const voterBefore = await token.balanceOf(signer.address);
  const roundBefore = await token.balanceOf(roundAddress);

  const tx = round.connect(signer).claimFunds();
  await expect(tx)
    .to.emit(round, "BitRefundReceived")
    .withArgs(signer.address, amount);
  await expect(tx)
    .to.emit(token, "Transfer")
    .withArgs(roundAddress, signer.address, amount);

  expect(await token.balanceOf(signer.address)).to.equal(voterBefore + amount);
  expect(await token.balanceOf(roundAddress)).to.equal(roundBefore - amount);
}

describe("costly abstention penalty", function () {
  async function runRound(informedCount, uninformedCount, abstainCount, costly) {
    const { owner, token, round, signers } = await deployFundedRound();
    const expected = publishedPayouts(informedCount, uninformedCount, costly);
    let cursor = 1;
    const informed = signers.slice(cursor, cursor + informedCount);
    cursor += informedCount;
    const uninformed = signers.slice(cursor, cursor + uninformedCount);
    cursor += uninformedCount;
    const abstainers = signers.slice(cursor, cursor + abstainCount);
    cursor += abstainCount;
    const bystander = signers[cursor];

    await castVotes(round, [
      ...informed.map((signer) => ({ signer, kind: VOTE_INFORMED })),
      ...uninformed.map((signer) => ({ signer, kind: VOTE_UNINFORMED })),
      ...abstainers.map((signer) => ({ signer, kind: VOTE_ABSTAIN })),
    ]);
    await round.connect(owner).closeRound();

    const tally = costly ? "tallyVotesSPOG" : "tallyVotesFREE";
    await expect(round.connect(owner)[tally]())
      .to.emit(round, "VotesTallied")
      .withArgs(expected.informed, expected.uninformed, expected.abstain);

    for (const signer of informed) {
      await expectClaim(token, round, signer, expected.informed);
    }
    for (const signer of uninformed) {
      await expectClaim(token, round, signer, expected.uninformed);
    }
    for (const signer of abstainers) {
      await expectClaim(token, round, signer, expected.abstain);
    }
    // Did not select abstain, so the abstain entitlement must not be paid here.
    await expectClaim(token, round, bystander, 0n);

    if (abstainers.length > 0) {
      await expect(round.connect(abstainers[0]).claimFunds()).to.be.revertedWith(
        "can only withdraw once"
      );
    }

    return { expected, round, token };
  }

  it("subtracts the 0.3 cap when the raw penalty exceeds it, then claimFunds pays that amount", async function () {
    // n=2, i=2, u=0. Raw v = 0.75, so the cap binds at 0.3.
    // Integer division stores v = 0 and pays the unpenalized base.
    const costly = await runRound(2, 0, 2, true);
    const free = publishedPayouts(2, 0, false);

    expect(costly.expected.penalty).to.equal(PENALTY_CAP);
    expect(costly.expected.base).to.equal(w(1));
    expect(costly.expected.abstain).to.equal(w(7) / 10n);
    expect(costly.expected.abstain).to.be.lt(free.abstain);
    expect(free.abstain).to.equal(free.base);
    expect(costly.expected.informed).to.equal(0n);
  });

  it("subtracts the uncapped penalty when it is below 0.3", async function () {
    // n=10, i=10, u=0. v = 19/100 = 0.19, which the 0.3 cap must not replace.
    // b = 5, so informed voters are owed 4 tokens and abstainers 4.81.
    const { expected } = await runRound(10, 0, 1, true);
    expect(expected.penalty).to.equal((19n * UNIT) / 100n);
    expect(expected.penalty).to.be.lt(PENALTY_CAP);
    expect(expected.base).to.equal(w(5));
    expect(expected.abstain).to.equal(expected.base - expected.penalty);
    expect(expected.informed).to.equal(w(4));
  });

  it("reduces the shared base by the uninformed share in both tally functions", async function () {
    // n=4, i=2, u=2. Real b = 0.75. Integer division drops u/n to 0 and
    // records b = 1, then drops v to 0.
    const spog = await runRound(2, 2, 1, true);
    const free = await runRound(2, 2, 1, false);

    expect(spog.expected.base).to.equal((75n * UNIT) / 100n);
    expect(free.expected.base).to.equal(spog.expected.base);
    expect(spog.expected.informed).to.equal(free.expected.informed);
    expect(spog.expected.uninformed).to.equal(free.expected.uninformed);
    expect(spog.expected.penalty).to.equal(PENALTY_CAP);
    expect(spog.expected.abstain).to.equal(spog.expected.base - PENALTY_CAP);
    expect(free.expected.abstain).to.equal(free.expected.base);
    expect(free.expected.penalty).to.equal(0n);
    expect(spog.expected.abstain).to.be.lt(free.expected.abstain);
  });

  it("keeps a positive fixed-point base when integer division truncates it to 0", async function () {
    // n=3, i=2, u=1. (n/2 - u/n) * i / n = 7/9, but every integer quotient in
    // the current base is 0, so both tallies record no entitlement at all.
    const spog = await runRound(2, 1, 1, true);
    const free = await runRound(2, 1, 1, false);
    const base = 777777777777777778n;

    expect(spog.expected.base).to.equal(base);
    expect(free.expected.base).to.equal(base);
    expect(spog.expected.informed).to.equal(0n);
    expect(spog.expected.uninformed).to.equal(base);
    expect(spog.expected.abstain).to.equal(base - PENALTY_CAP);
    expect(free.expected.abstain).to.equal(base);
  });

  it("evaluates a one-vote round in fixed point and still caps the penalty", async function () {
    // n=1, i=1, u=0. n/2 truncates to 0 in integer division, and the raw
    // penalty is 1, which must be capped to 0.3 before it is subtracted.
    const { expected } = await runRound(1, 0, 1, true);
    expect(expected.base).to.equal(w(1) / 2n);
    expect(expected.penalty).to.equal(PENALTY_CAP);
    expect(expected.abstain).to.equal(expected.base - PENALTY_CAP);
    expect(expected.informed).to.equal(0n);
    expect(expected.uninformed).to.equal(expected.base);
  });

  it("pays every address that selected abstain, and pays a non-voter nothing", async function () {
    const { expected } = await runRound(4, 0, 3, true);
    // n=4, i=4, u=0. b = 2, raw v = 0.4375, capped v = 0.3, abstain = 1.7.
    expect(expected.base).to.equal(w(2));
    expect(expected.abstain).to.equal(w(17) / 10n);
    expect(expected.informed).to.equal(w(1));
  });

  it("records a zero project payout when nobody casts an informed vote", async function () {
    const spog = await runRound(0, 3, 2, true);
    const free = await runRound(0, 3, 2, false);
    expect(spog.expected.base).to.equal(0n);
    expect(spog.expected.abstain).to.equal(0n);
    expect(spog.expected.uninformed).to.equal(0n);
    expect(free.expected.abstain).to.equal(0n);
  });

  it("does not tally a round whose only votes are abstentions", async function () {
    const { owner, round, signers } = await deployFundedRound();
    await round.connect(signers[1]).vote(VOTE_ABSTAIN);
    await round.connect(signers[2]).vote(VOTE_ABSTAIN);
    await round.connect(owner).closeRound();

    await expect(round.connect(owner).tallyVotesSPOG()).to.be.revertedWith(
      "no votes submitted"
    );
    await expect(round.connect(owner).tallyVotesFREE()).to.be.revertedWith(
      "no votes submitted"
    );
  });
});
