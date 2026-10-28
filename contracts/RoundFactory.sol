// SPDX-License-Identifier: UNLICENSED
//author: @lstephanian

pragma solidity ^0.8.9;

import './Round.sol';
import { ExperimentToken } from './ExperimentToken.sol';
import "@openzeppelin/contracts/access/Ownable.sol";
//note: this contract gets published first

contract RoundFactory is Ownable(msg.sender) {
    address[] public rounds;
    event RoundCreated(address);
    event AllRounds(address[]);
    ExperimentToken exp = new ExperimentToken();

    //create round
    function createRound(address _ExperimentTokenAddress, uint _roundMintAmount) public onlyOwner {
        Round round = new Round(_ExperimentTokenAddress, msg.sender);
        
        emit RoundCreated(address(round));
        rounds.push(address(round));

        //auto mint tokens to each round
        exp.mint(address(round), _roundMintAmount);
    }

    function allRounds() public view returns (address[] memory) {
        return rounds;
    }
}