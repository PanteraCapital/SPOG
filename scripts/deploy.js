const hre = require('hardhat');

async function main() {
  // const experimentToken = await hre.ethers.deployContract('ExperimentToken');
  // await experimentToken.waitForDeployment();
  // console.log(`ExperimentToken deployed to ${experimentToken.target}`);

  // const roundFactory = await hre.ethers.deployContract('RoundFactory');
  // await roundFactory.waitForDeployment();
  // console.log(`RoundFactory deployed to ${roundFactory.target}`);
  
  const [deployer] = await hre.ethers.getSigners();
  const round = await hre.ethers.deployContract('Round', ['0x7172968cd3090ab3655387f24b1edE7C297FB117', deployer.address]);
  await round.waitForDeployment();
  console.log(`Round deployed to ${round.target}`); 
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});