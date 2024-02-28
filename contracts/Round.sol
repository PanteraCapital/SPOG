// SPDX-License-Identifier: UNLICENSED
//author: @lstephanian

pragma solidity ^0.8.9;

import "@openzeppelin/contracts/access/Ownable.sol";

contract Round is Ownable(msg.sender) {
    int votesUninformed = 0;
    int votesInformed = 0;
    int votesAbstain = 0;
    int informedClaimable = 0;
    int uninformedClaimable = 0;
    int abstainedClaimable = 0;
    bool public ended = false;
    int multiplier = 10**6;

    mapping(address => int) private voteMap;
    mapping(address => bool) private withdrawalMap;

    event RoundCreated(bool);
    event RoundEnded(bool);
    event VoteSubmitted(int, int);
    event VotesTallied(int informedClaimable, int uninformedClaimable, int abstainedClaimable);
    event BitRefundReceived(address, int);

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

    function tallyVotesExpensive() public onlyOwner {
        require(ended, 'round is still open');

        int votesTotal = votesInformed + votesUninformed; 
        require(votesTotal > 0, "no votes submitted");

        int b = ((((votesTotal * multiplier) / 2) - (votesUninformed * multiplier / votesTotal)) * votesInformed) / votesTotal;
        int v = ((votesTotal - 1) * multiplier) / (votesTotal * votesTotal) + ((1 * multiplier) / votesTotal);
        
        if (v * 10 > 3) {
            v = (3 * multiplier) / 10;
        }
        
        if (b > 1 * multiplier) {
            informedClaimable = (b - (1* multiplier)) / multiplier;
        }
        if (b > 0) {
            uninformedClaimable = b / multiplier;
        }
        if (b-v > 0) {
            abstainedClaimable = ( b - v ) / multiplier;
        }
        emit VotesTallied(informedClaimable, uninformedClaimable, abstainedClaimable);
    }
    
    function tallyVotesFree() public onlyOwner {
        require(ended, 'round is still open');

        int votesTotal = votesInformed + votesUninformed;
        require(votesTotal > 0, "no votes submitted");

        int b = ((((votesTotal * multiplier) / 2) - (votesUninformed * multiplier) / votesTotal) * votesInformed) / votesTotal;
        
        if (b > 1 * multiplier) {
            informedClaimable = ((b * multiplier) - (1 * multiplier)) / multiplier;
        }
        if (b > 0) {
            uninformedClaimable = b / multiplier;
            abstainedClaimable = b  / multiplier;
        }
    
        emit VotesTallied(informedClaimable, uninformedClaimable, abstainedClaimable);
    }

    function claimFunds() public {
        require(ended, 'round is still open');
        require(withdrawalMap[msg.sender] == false, 'can only withdraw once');
        int amount;

        if (voteMap[msg.sender] == 1){
            value = abstainedClaimable;
        }
        if (voteMap[msg.sender] == 2){
            value = votesUninformed;
        }
        if (voteMap[msg.sender] == 3){
            value = votesInformed;
        }        
        
        withdrawalMap[msg.sender] = true;
        
        (bool sent, bytes memory data) = _to.call{value: msg.value}("");
        require(sent, "Failed to send Ether");
        
        emit BitRefundReceived(msg.sender, value);
    }
}