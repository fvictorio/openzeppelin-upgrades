import { Manifest, getAdminAddress, getCode, EthereumProvider, isEmptySlot } from '@openzeppelin/upgrades-core';

import {
  ContractClass,
  ContractInstance,
  wrapProvider,
  deployProxyImpl,
  getITransparentUpgradeableProxyFactory,
  getProxyAdminFactory,
  UpgradeProxyOptions,
  withDefaults,
  getContractAddress,
  ContractAddressOrInstance,
} from './utils';

export async function upgradeProxy(
  proxy: ContractAddressOrInstance,
  Contract: ContractClass,
  opts: UpgradeProxyOptions = {},
): Promise<ContractInstance> {
  const { deployer } = withDefaults(opts);
  const provider = wrapProvider(deployer.provider);

  const proxyAddress = getContractAddress(proxy);

  const upgradeTo = await getUpgrader(provider, Contract, proxyAddress);
  const { impl: nextImpl } = await deployProxyImpl(Contract, opts, proxyAddress);
  const call = encodeCall(Contract, opts.call);
  const { tx: txHash } = await upgradeTo(nextImpl, call);

  Contract.address = proxyAddress;
  Contract.transactionHash = txHash;
  const contract = new Contract(proxyAddress);
  contract.transactionHash = txHash;
  return contract;
}

type Upgrader = (nextImpl: string, call?: string) => Promise<{ tx: string }>;

async function getUpgrader(
  provider: EthereumProvider,
  contractTemplate: ContractClass,
  proxyAddress: string,
): Promise<Upgrader> {
  const adminAddress = await getAdminAddress(provider, proxyAddress);
  const adminBytecode = await getCode(provider, adminAddress);

  if (isEmptySlot(adminAddress) || adminBytecode === '0x') {
    // No admin contract: use ITransparentUpgradeableProxyFactory to get proxiable interface
    const ITransparentUpgradeableProxyFactory = getITransparentUpgradeableProxyFactory(contractTemplate);
    const proxy = new ITransparentUpgradeableProxyFactory(proxyAddress);

    return (nextImpl, call) => {
      return call ? proxy.upgradeToAndCall(nextImpl, call) : proxy.upgradeTo(nextImpl);
    };
  } else {
    // Admin contract: redirect upgrade call through it
    const manifest = await Manifest.forNetwork(provider);
    const AdminFactory = getProxyAdminFactory(contractTemplate);
    const admin = new AdminFactory(adminAddress);
    const manifestAdmin = await manifest.getAdmin();

    if (admin.address !== manifestAdmin?.address) {
      throw new Error('Proxy admin is not the one registered in the network manifest');
    }

    return (nextImpl, call) => {
      return call ? admin.upgradeAndCall(proxyAddress, nextImpl, call) : admin.upgrade(proxyAddress, nextImpl);
    };
  }
}

function encodeCall(factory: ContractClass, call: UpgradeProxyOptions['call']): string | undefined {
  if (!call) {
    return undefined;
  }

  if (typeof call === 'string') {
    call = { fn: call };
  }

  const contract = new (factory as any).web3.eth.Contract((factory as any)._json.abi);
  return contract.methods[call.fn](...(call.args ?? [])).encodeABI();
}
