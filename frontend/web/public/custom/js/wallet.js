import { createWeb3Modal, defaultWagmiConfig } from '@web3modal/wagmi'
import { getContract, prepareWriteContract, writeContract, disconnect, getAccount, signMessage } from '@wagmi/core'
import { mainnet, arbitrum, arbitrumSepolia, sepolia } from '@wagmi/core/chains'
import Swal from 'sweetalert2';
import 'sweetalert2/dist/sweetalert2.min.css';

const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID;

const metadata = {
  name: 'Web3Modal',
  description: 'Web3Modal Example',
  url: 'https://web3modal.com',
  icons: ['https://avatars.githubusercontent.com/u/37784886']
};

arbitrumSepolia.name = 'Sepolia Arbitrum';

const defaultChain = arbitrumSepolia;
const chains = [defaultChain, arbitrum];
const wagmiConfig = defaultWagmiConfig({ chains, projectId, metadata });
var account = getAccount();

function accountConnected() {
  document.getElementById('contracts-menu').removeClass('d-none');
  loadPage(100);
}

// 3. Create modal
const modal = createWeb3Modal({ wagmiConfig, projectId, chains, defaultChain, themeMode: "light"});
modal.subscribeEvents(event => {
  if (event.data.event != 'MODAL_OPEN') {
    return;
  }

  let intervalId = setInterval(function() {
    if (document.querySelector("body > w3m-modal")) {
      clearInterval(intervalId);
    } else {
      loadPage(100);
      return;
    }

    const modal = document.querySelector("body > w3m-modal").shadowRoot;
    if (modal.querySelector("wui-flex > wui-card > w3m-router").shadowRoot.querySelector("div > w3m-account-view")) {
      accountConnected();
      return;
    }

    const elems = {
      'modal': modal,
      'card': modal.querySelector("wui-flex > wui-card"),
      'header': modal.querySelector("wui-flex > wui-card > w3m-header").shadowRoot,
      'body': modal.querySelector("wui-flex > wui-card > w3m-router").shadowRoot.querySelector("div > w3m-connect-view").shadowRoot,
    }

    elems.card.style.backgroundColor = '#ffffff';
    elems.card.style.maxWidth = '50vw';
    elems.card.style.borderRadius = '10px';

    elems.header.querySelector("wui-separator").style.display = 'none';
    elems.header.querySelector("wui-flex").style.cssText = "align-items: center; justify-content: space-between; background-color: #e6e6e6; margin: 10px; padding: 10px 5px 10px 10px;";
    elems.header.querySelector("wui-flex > wui-text").style.textTransform = 'uppercase';
    elems.header.querySelector("wui-flex > wui-text").insertAdjacentHTML("afterend", '<div style="flex-grow: 1;padding: 0 10px 0 15px;"><div style="background: url(/dist/img/dots.png) repeat-x;height: 28px;width: 100%;"></div></div>');
    elems.header.querySelector('wui-flex > wui-icon-link#dynamic').remove();
    elems.header.querySelector('wui-flex > wui-icon-link[icon="close"]').style.backgroundImage = 'url(/dist/img/close.png)';
    elems.header.querySelector("wui-flex > wui-icon-link").shadowRoot.querySelector("button > wui-icon").style.color = 'transparent';

    elems.body.querySelectorAll("wui-flex > wui-list-wallet").forEach(function(elem) {
      elem.style.backgroundColor = '#e6e6e6';
      elem.style.boxShadow = '0px 0px 0px 3px #e6e6e6, 0 3px 0 3px #bac9bf';
      elem.style.border = '1px solid #000';
      elem.style.margin = '0 5px 13px';
      elem.shadowRoot.querySelector('button').style.borderRadius = '0';
    });

    loadPage(100);
  }, 500);
});

const errorElem = document.getElementById('error-message');
const loadingElem = document.getElementById('loading');

loadPage(50);

function onVoteClick(contractAddress, abi) {
  let links = document.getElementsByClassName('contract-vote');
  for (let i = 0, iLength = links.length; i < iLength; i++) {
    links[i].addEventListener('click', async function(e) {
      e.preventDefault();

      if (loadingElem.style.display === '') {
        return;
      }
      errorElem.style.display = 'none';
      loadingElem.style.display = '';

      account = getAccount();
      if (account.isConnected) {
        accountConnected();
        try {
          await writeContract({
            address: contractAddress,
            account: account,
            abi: abi,
            functionName: 'vote',
            args: [e.target.getAttribute('data-vote')],
          });

          Swal.fire({
            title: 'Vote',
            text: 'Thank you for voting',
            icon: 'success',
          });

          let spanElem = document.getElementById('vote-count-' + e.target.getAttribute('data-vote'));
          spanElem.innerText = parseInt(spanElem.innerText) + 1;
        } catch (error) {
          [['round closed', 'This round has closed.'], ['vote once', 'You can only vote once!']].forEach(function(err) {
            if (error.shortMessage.indexOf(err[0]) === -1) {
              return;
            }

            errorElem.style.display = '';
            errorElem.innerText = 'Err: ' + err[1];
          });
        }

        loadingElem.style.display = 'none';
      }
    });
  }
}

try {  // Error when address and abi doesn't exist
  onVoteClick(contractAddress, abi);
} catch (err) {}

if (!account.isConnected) {
  modal.open();
} else {
  accountConnected();
}
