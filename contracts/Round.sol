// SPDX-License-Identifier: UNLICENSED
//author: @lstephanian

pragma solidity ^0.8.9;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { ExperimentToken } from './ExperimentToken.sol';
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { UD60x18, convert, UNIT, ZERO } from "@prb/math/src/UD60x18.sol";

contract Round is Ownable(msg.sender) {
    UD60x18 constant PENALTY_CAP = UD60x18.wrap(0.3e18);

    int votesUninformed = 0;
    int votesInformed = 0;
    int votesAbstain = 0;
    int informedClaimable = 0;
    int uninformedClaimable = 0;
    int abstainedClaimable = 0;

    mapping(address => int) private voteMap;
    mapping(address => bool) private withdrawalMap;

    address public immutable TOKEN_ADDRESS;
    bool public ended = false;

    event RoundCreated(bool);
    event RoundEnded(bool);
    event VoteSubmitted(int, int);
    event VotesTallied(int informedClaimable, int uninformedClaimable, int abstainedClaimable);
    event BitRefundReceived(address, int);
    ExperimentToken exp;


    constructor (address _tokenAddress){
        TOKEN_ADDRESS = _tokenAddress;
        emit RoundCreated(true);
    }

    function closeRound() public onlyOwner {
        ended = true;
        emit RoundEnded(ended);
    }

    function getRoundStatus() public view returns(bool) {
        return(ended);
    }

    function vote(int _voteType) public {
        require(ended==false, "round closed");
        require(_voteType > 0 && _voteType < 4, 'needs to be in range');
        require(voteMap[msg.sender] == 0, 'can only vote once');

        voteMap[msg.sender] = _voteType;

        if (_voteType==1){
            votesAbstain += 1;
            emit VoteSubmitted(_voteType, votesAbstain);
        }
        if (_voteType==2){
            votesUninformed += 1;
            emit VoteSubmitted(_voteType, votesUninformed);
        }
        if (_voteType==3) {
            votesInformed += 1;
            emit VoteSubmitted(_voteType, votesInformed);
        }
    }

    function getVoterStatus(address beneficiary) public view returns(int) {
        return(voteMap[beneficiary]);
    }

    function tallyVotesSPOG() public onlyOwner {
        _tallyVotes(true);
    }
    
    function tallyVotesFREE() public onlyOwner {
        _tallyVotes(false);
    }

    // Claimable amounts are UD60x18 values, i.e. token wei (1 token = 1e18).
    function _tallyVotes(bool costlyAbstention) private {
        require(ended, 'round is still open');

        int votesTotal = votesInformed + votesUninformed;
        require(votesTotal > 0, "no votes submitted");

        UD60x18 n = convert(uint(votesTotal));
        UD60x18 i = convert(uint(votesInformed));
        UD60x18 u = convert(uint(votesUninformed));

        // b = ((n/2 - u/n) * i) / n. The difference is only negative when n = u = 1,
        // where i = 0 and b is 0 anyway.
        UD60x18 half = n.div(convert(2));
        UD60x18 uninformedShare = u.div(n);
        UD60x18 quality = half > uninformedShare ? half - uninformedShare : ZERO;
        UD60x18 b = quality.mul(i).div(n);

        // v = min(0.3, (n-1)/n^2 + 1/n), only charged when abstention is costly.
        UD60x18 v = ZERO;
        if (costlyAbstention) {
            v = (n - UNIT).div(n.mul(n)) + UNIT.div(n);
            if (v > PENALTY_CAP) {
                v = PENALTY_CAP;
            }
        }

        informedClaimable = _toInt(b > UNIT ? b - UNIT : ZERO);
        uninformedClaimable = _toInt(b);
        abstainedClaimable = _toInt(b > v ? b - v : ZERO);

        emit VotesTallied(informedClaimable, uninformedClaimable, abstainedClaimable);
    }

    function _toInt(UD60x18 x) private pure returns (int) {
        return SafeCast.toInt256(x.unwrap());
    }

    function claimFunds() public {
        require(ended, 'round is still open');
        require(withdrawalMap[msg.sender] == false, 'can only withdraw once');
        int amount;

        if (voteMap[msg.sender] == 1){
            amount = abstainedClaimable;
        }
        if (voteMap[msg.sender] == 2){
            amount = uninformedClaimable;
        }
        if (voteMap[msg.sender] == 3){
            amount = informedClaimable;
        }        
        
        withdrawalMap[msg.sender] = true;
        
        exp = ExperimentToken(TOKEN_ADDRESS);
        require(exp.transfer(msg.sender, uint(amount)));
        emit BitRefundReceived(msg.sender, amount);
    }
}