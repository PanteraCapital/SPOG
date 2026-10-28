// SPDX-License-Identifier: UNLICENSED
//author: @lstephanian

pragma solidity ^0.8.9;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { ExperimentToken } from './ExperimentToken.sol';
import "@openzeppelin/contracts/utils/math/Math.sol";

contract Round is Ownable {
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


    constructor (address _tokenAddress, address _initialOwner) Ownable(_initialOwner) {
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
        require(ended, 'round is still open');

        int votesTotal = votesInformed + votesUninformed; 
        require(votesTotal > 0, "no votes submitted");

        int b = (votesTotal/2 - votesUninformed / votesTotal) * votesInformed / votesTotal; 
        int v = ((votesTotal - 1) / (votesTotal * votesTotal)) + (1  / votesTotal);

        // allows for up to 10**59 votes
        if (v * 10**18 > 3**18) {
            v = 3**18;
        }

        if (b > 1) {
            informedClaimable = b-1;
        }
        if (b > 0) {
            uninformedClaimable = b;
        }
        if (b-v > 0) {
            abstainedClaimable = b * 10**18 > v ? b * 10**18 - v : int(0);
        }
        emit VotesTallied(informedClaimable, uninformedClaimable, abstainedClaimable);
    }
    
    function tallyVotesFREE() public onlyOwner {
        require(ended, 'round is still open');

        int votesTotal = votesInformed + votesUninformed;
        require(votesTotal > 0, "no votes submitted");

        int b = (int(votesTotal) / 2 - (int(votesUninformed) / int(votesTotal))) * int(votesInformed) / int(votesTotal);

        if (b > 1) {
            informedClaimable = b-1;
        }

        if (b > 0) {
            uninformedClaimable = b;
            abstainedClaimable = b;
        }
    
        emit VotesTallied(informedClaimable, uninformedClaimable, abstainedClaimable);
    }

    function claimFunds() public {
        require(ended, 'round is still open');
        require(withdrawalMap[msg.sender] == false, 'can only withdraw once');
        int amount;

        if (voteMap[msg.sender] == 0){
            amount = abstainedClaimable;
        }
        if (voteMap[msg.sender] == 1){
            amount = votesUninformed;
        }
        if (voteMap[msg.sender] == 2){
            amount = votesInformed;
        }        
        
        withdrawalMap[msg.sender] = true;
        
        exp = ExperimentToken(TOKEN_ADDRESS);
        require(exp.transfer(msg.sender, uint(amount)));
        emit BitRefundReceived(msg.sender, amount);
    }
}