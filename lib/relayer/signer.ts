import { ethers } from 'ethers';
import { fiatTokenAbi } from '@/FiatTokenAbi';
import { sponsoredUsdcMapping, type SponsoredUsdcConfig } from '@/sponsoredUsdcConfig';
import { requireEnv } from '@/lib/env';

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

// Raw private key, not a mnemonic: a BIP-39 phrase is the master key for an entire derivation tree,
// so the blast radius of an env leak was the whole wallet rather than one relayer account.
const RELAYER_KEY = requireEnv('PAYMASTER_PRIVATE_KEY');
const EXPECTED_ADDRESS = ethers.utils.getAddress(requireEnv('PAYMASTER_ADDRESS'));
const GAS_BALANCE_FLOOR = ethers.utils.parseEther(process.env.PAYMASTER_MIN_BALANCE_ETH ?? '0.01');

const baseSigner = new ethers.Wallet(RELAYER_KEY);
if (baseSigner.address !== EXPECTED_ADDRESS) {
  // The old code read the nonce for PAYMASTER_ADDRESS but signed with PAYMASTER_MNEMONIC,
  // so any drift between the two silently produced transactions at a foreign account's nonce.
  throw new Error(`PAYMASTER_PRIVATE_KEY derives ${baseSigner.address}, expected ${EXPECTED_ADDRESS}`);
}

interface ChainContext {
  readonly config: SponsoredUsdcConfig;
  readonly relayer: ethers.Wallet;
  readonly token: ethers.Contract;
  readonly domain: ethers.TypedDataDomain;
}

const contexts = new Map<number, Promise<ChainContext>>();

export function getChainContext(chainId: number): Promise<ChainContext> {
  const cached = contexts.get(chainId);
  if (cached) return cached;

  const built = buildChainContext(chainId).catch((error: unknown) => {
    contexts.delete(chainId); // never cache a failed handshake
    throw error;
  });
  contexts.set(chainId, built);
  return built;
}

async function buildChainContext(chainId: number): Promise<ChainContext> {
  const config = sponsoredUsdcMapping.find((entry) => entry.chainId === chainId);
  if (!config) throw new UnsupportedChainError(chainId);

  // StaticJsonRpcProvider: the chainId is known, so drop ethers' per-instance eth_chainId
  // detectNetwork round-trip that the old per-request `new JsonRpcProvider` paid every time.
  const provider = new ethers.providers.StaticJsonRpcProvider(config.rpc, chainId);
  const relayer = baseSigner.connect(provider);
  const token = new ethers.Contract(config.fiatTokenAddress, fiatTokenAbi, relayer);

  // Read name/version from chain rather than hardcoding string literals, then assert the computed
  // separator against BOTH the configured constant (previously dead code) and the on-chain value.
  const [name, version, onChainSeparator] = await Promise.all([
    token.name() as Promise<string>,
    token.version() as Promise<string>,
    token.DOMAIN_SEPARATOR() as Promise<string>,
  ]);

  const domain: ethers.TypedDataDomain = {
    name, version, chainId, verifyingContract: config.fiatTokenAddress,
  };
  const computed = ethers.utils._TypedDataEncoder.hashDomain(domain);

  if (computed !== onChainSeparator || computed.toLowerCase() !== config.domainSeparator.toLowerCase()) {
    throw new Error(
      `EIP-712 domain mismatch on chain ${chainId}: computed=${computed} ` +
      `onChain=${onChainSeparator} configured=${config.domainSeparator}`,
    );
  }
  return { config, relayer, token, domain };
}

export async function assertGasBudget(ctx: ChainContext): Promise<void> {
  const balance = await ctx.relayer.getBalance();
  if (balance.lt(GAS_BALANCE_FLOOR)) throw new GasBudgetExhaustedError(ctx.config.chainId);
}

export class UnsupportedChainError extends Error {
  constructor(readonly chainId: number) { super(`Unsupported chain: ${chainId}`); }
}
export class GasBudgetExhaustedError extends Error {
  constructor(readonly chainId: number) { super(`Relayer gas budget exhausted on chain ${chainId}`); }
}