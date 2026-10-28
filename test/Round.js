require("@nomicfoundation/hardhat-toolbox");
let { expect } = require('chai')
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs")


describe("Round", function () {
  beforeEach(async function () {
    [owner, addr1, addr2, addr3, addr4, addr5, addr6, addr7, addr8] = await ethers.getSigners();

    //deploy exp tokens contract
    ExperimentToken = await ethers.getContractFactory("ExperimentToken");
    exp = await ExperimentToken.deploy();
    expContract = await exp.waitForDeployment();
    expContractAddy = await exp.getAddress();

    //deploy round contract
    Round = (await ethers.getContractFactory("Round"));
    round = await Round.connect(owner).deploy(expContractAddy, owner.address);
    roundContract = await round.waitForDeployment();
    roundContractAddy = await round.getAddress();
  });

  describe("Deployment", function () {
    it("should deploy successfully", async function () {
      expect(await roundContractAddy).to.be.properAddress;
    });
    
    it("should emit an event upon deployment", async function () {
      let myRound = await Round.connect(owner).deploy(expContractAddy, owner.address);
      expect(await myRound.waitForDeployment())
          .to.emit(myRound, "RoundCreated")
          .withArgs(true);     
    });
  });

  describe("Round Close", function () {
    it("only owner should be able to access", async function () {
      expect(roundContract.connect(addr1).closeRound())
        .to.be.reverted;
    });
    it("sets round to ended", async function () {
      expect(await roundContract.closeRound())
        .to.emit(roundContract, "RoundEnded"); 
      expect(await roundContract.getRoundStatus())
        .to.equal(true);
    });
  });
  describe("Vote", function () {
    it("should allow any user to vote", async function () {
      newRound = await round.waitForDeployment();
      expect(await newRound.connect(owner).vote(1))
        .is.not.reverted;
      expect(await newRound.connect(addr1).vote(1))
        .is.not.reverted;
      expect(await newRound.connect(addr2).vote(1))
        .is.not.reverted;
      expect(await newRound.connect(addr3).vote(1))
        .is.not.reverted;
    });
    it("should revert if incorrect vote type indicated", async function () {
      newRound2 = await round.waitForDeployment();
      expect(newRound2.connect(addr1).vote(3))
        .is.revertedWith('Needs to be in range');
    });
    it("should emit event upon vote", async function () {
      newRound3 = await round.waitForDeployment();
      expect(await newRound3.connect(addr1).vote(2))
        .to.emit(newRound3, "VoteSubmitted"); 
    });
    it("should increment vote tracker", async function () {
      newRound4 = await round.waitForDeployment();
      let vote1 = await newRound4.connect(owner).vote(1);
      await expect(await newRound4.connect(addr1).vote(1))
        .to.emit(newRound4, "VoteSubmitted")
        .withArgs(1, 2);

      let vote3 = await newRound4.connect(addr2).vote(2);
      let vote4 = await newRound4.connect(addr3).vote(2);
      await expect(await newRound4.connect(addr4).vote(2))
        .to.emit(newRound4, "VoteSubmitted")
        .withArgs(2, 3);
    });
    it("should ensure voters can only vote once", async function () {
      newRound5 = await round.waitForDeployment();
      let vote = await newRound5.connect(addr1).vote(1);
      expect(await newRound5.connect(addr3).vote(2))
        .to.be.revertedWith('can only vote once');
    });
    it("should update vote map", async function (){
      newRound6 = await round.waitForDeployment();
      let vote = await newRound6.connect(addr1).vote(1);
      expect(await newRound6.getVoterStatus(addr1))
        .to.equal(1)
    });
  });
  describe("Tally Votes", function () {
    describe("SPOG", function () {
      it("only owner can tally votes", async function () {
        await roundContract.connect(addr1).vote(1);
        await roundContract.connect(owner).closeRound();
        expect(roundContract.connect(addr1).tallyVotesSPOG())
          .to.be.reverted;
      });
      it("requires round is closed", async function () {
        await roundContract.connect(addr1).vote(1);
        expect(roundContract.connect(owner).tallyVotesSPOG())
          .to.be.revertedWith('round is still open');
      });
      it("requires at least one vote", async function () {
        await roundContract.connect(owner).closeRound();
        expect(roundContract.connect(owner).tallyVotesSPOG())
          .to.be.revertedWith('no votes submitted');
      });

      it("should tally votes as expected", async function () {
        newRound7 = await round.waitForDeployment();

        let vote1 = await newRound7.connect(addr1).vote(1);
        let vote2 = await newRound7.connect(addr2).vote(1);
        let vote3 = await newRound7.connect(addr3).vote(1);
        let vote4 = await newRound7.connect(addr4).vote(2);
        let vote6 = await newRound7.connect(addr6).vote(2);
        let vote7 = await newRound7.connect(addr7).vote(3);
        let vote8 = await newRound7.connect(addr8).vote(3);

        await newRound7.connect(owner).closeRound();
        await newRound7.connect(owner).tallyVotesSPOG();

        expect(newRound7.connect(owner).tallyVotesSPOG())
        .to.emit(newRound7, "VotesTallied")
        .withArgs(0, 1, 1000000000000000000);
      });

    });
    describe("FREE", function () {
      it("only owner can tally votes", async function () {
        expect(roundContract.connect(addr1).tallyVotesFREE())
          .to.be.reverted;
      });
      it("should tally votes as expected", async function () {
        newRound9 = await round.waitForDeployment();

        let vote1 = await newRound9.connect(addr1).vote(1);
        let vote2 = await newRound9.connect(addr2).vote(1);
        let vote3 = await newRound9.connect(addr3).vote(1);
        let vote4 = await newRound9.connect(addr4).vote(2);
        let vote6 = await newRound9.connect(addr6).vote(2);
        let vote7 = await newRound9.connect(addr7).vote(3);
        let vote8 = await newRound9.connect(addr8).vote(3);

        await newRound9.connect(owner).closeRound();

        expect(newRound9.connect(owner).tallyVotesFREE())
        .to.emit(newRound7=9, "VotesTallied")
        .withArgs(0, 1, 1);
      });
    });
  });
  describe("Claim Funds", function () {
    it("should revert if round still open", async function () {
      newRound8 = await round.waitForDeployment();
      expect(newRound8.connect(addr1).claimFunds())
        .to.be.revertedWith('round is still open');
    });
    it("should allow anyone to try to claim", async function () {
      newRound8 = await round.waitForDeployment();
      await newRound8.connect(owner).closeRound();
      expect(newRound8.connect(addr1).claimFunds())
        .to.emit(newRound8, "BitRefundReceived")
        .withArgs(owner.address, anyValue);
    });
  });
});
