import { fiatTokenAbi } from '@/FiatTokenAbi';
import { applyCors } from '@/services/cors';
import { appendTxHashToPayment, authorizePayment } from '@/services/paymentTxOrMsgService';
import { sponsoredUsdcMapping, type SponsoredUsdcConfig } from '@/sponsoredUsdcConfig';
import { ethers } from 'ethers';
import type { NextApiRequest, NextApiResponse } from 'next';

type TxHashReceivedResponse = {
  txHash: string;
};

type SponsoredRelayResponse = {
  data?: ethers.providers.TransactionResponse | TxHashReceivedResponse;
  message?: string;
};

/**
 * EIP-712 primary type for the EIP-3009 authorization this relayer sponsors.
 * Any other primary type is rejected: the relayer must never be persuaded to
 * sponsor a signature over a different struct.
 */
const EXPECTED_PRIMARY_TYPE = 'TransferWithAuthorization';

/**
 * Canonical EIP-712 type definition used to recover the authorization signer.
 *
 * Annotated rather than declared `as const`: `ethers.utils.verifyTypedData`
 * takes `Record<string, TypedDataField[]>`, and a `readonly` tuple is not
 * assignable to that mutable array type. The structural annotation below matches
 * `TypedDataField` without importing it from an indirect dependency.
 */
const TRANSFER_WITH_AUTHORIZATION_TYPES: Record<string, { name: string; type: string }[]> = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

/**
 * Hard ceiling on the effective gas price this relayer will pay, in gwei.
 *
 * Without a cap the sponsor pays whatever the RPC reports, so a fee spike — or an
 * RPC returning a nonsense value — is charged directly to the sponsor wallet.
 */
const MAX_FEE_PER_GAS_GWEI = Number(process.env.PAYMASTER_MAX_FEE_GWEI ?? '50');

/** Upper bound on the sponsored gas limit, to bound the cost of any single relay. */
const MAX_GAS_LIMIT = 400_000;

/**
 * Serializes nonce allocation and broadcast.
 *
 * `getTransactionCount` reads the pending count and is not reserved, so two
 * concurrent requests previously received the same nonce and one of the two
 * broadcasts always failed with "nonce too low" / "replacement underpriced".
 * Chaining every submission through a single promise makes allocation and
 * broadcast atomic within this process.
 *
 * This is a per-process lock. A multi-instance deployment still needs an external
 * nonce manager; that limitation is called out here rather than being papered
 * over.
 */
let submissionChain: Promise<unknown> = Promise.resolve();

function serializeSubmission<T>(work: () => Promise<T>): Promise<T> {
  const result = submissionChain.then(work, work);
  // Keep the chain alive regardless of individual outcomes.
  submissionChain = result.catch(() => undefined);
  return result;
}

/** Narrow a value to a 0x-prefixed 32-byte hex string. */
function isHex32(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

/** Narrow a value to a 0x-prefixed 65-byte signature. */
function isSignature(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{130}$/.test(value);
}

/** Narrow a value to a non-negative integer expressed as a string or number. */
function toBigNumber(value: unknown): ethers.BigNumber | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }
  try {
    const parsed = ethers.BigNumber.from(value);
    return parsed.isNegative() ? null : parsed;
  } catch {
    return null;
  }
}

type ValidatedAuthorization = {
  from: string;
  to: string;
  value: ethers.BigNumber;
  validAfter: ethers.BigNumber;
  validBefore: ethers.BigNumber;
  nonce: string;
  signature: string;
  sponsoredInfo: SponsoredUsdcConfig;
};

/**
 * Validates the submitted EIP-712 payload end to end.
 *
 * Every field consumed downstream is checked here, because all of them originate
 * in the request body. The previous implementation destructured
 * `typedData.message` directly, so a missing `typedData` threw a `TypeError`
 * outside any try/catch and a malformed authorization was passed straight to the
 * chain at the sponsor's expense.
 *
 * @returns The validated authorization, or a human-readable rejection reason.
 */
function validateAuthorization(body: unknown):
  | { ok: true; value: ValidatedAuthorization }
  | { ok: false; reason: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, reason: 'Request body must be a JSON object' };
  }

  const { typedData, signature } = body as Record<string, unknown>;

  if (!isSignature(signature)) {
    return { ok: false, reason: 'signature must be a 65-byte hex string' };
  }
  if (typeof typedData !== 'object' || typedData === null) {
    return { ok: false, reason: 'typedData is required' };
  }

  const { domain, message, primaryType } = typedData as Record<string, unknown>;

  if (primaryType !== undefined && primaryType !== EXPECTED_PRIMARY_TYPE) {
    return { ok: false, reason: `primaryType must be ${EXPECTED_PRIMARY_TYPE}` };
  }
  if (typeof domain !== 'object' || domain === null) {
    return { ok: false, reason: 'typedData.domain is required' };
  }
  if (typeof message !== 'object' || message === null) {
    return { ok: false, reason: 'typedData.message is required' };
  }

  const domainFields = domain as Record<string, unknown>;
  const messageFields = message as Record<string, unknown>;

  const chainId = Number(domainFields.chainId);
  if (!Number.isInteger(chainId)) {
    return { ok: false, reason: 'typedData.domain.chainId must be an integer' };
  }

  // Chain allowlist. Only chains with a configured, deployed USDC contract are
  // eligible for sponsorship.
  const sponsoredInfo = sponsoredUsdcMapping.find((entry) => entry.chainId === chainId);
  if (!sponsoredInfo) {
    return { ok: false, reason: 'Unsupported chain' };
  }

  // Bind the signature to the token contract this relayer is willing to sponsor.
  // Without this check an authorization signed for an unrelated contract on the
  // same chain would still be relayed.
  const verifyingContract = domainFields.verifyingContract;
  if (
    typeof verifyingContract !== 'string' ||
    !ethers.utils.isAddress(verifyingContract) ||
    ethers.utils.getAddress(verifyingContract) !==
      ethers.utils.getAddress(sponsoredInfo.fiatTokenAddress)
  ) {
    return {
      ok: false,
      reason: 'typedData.domain.verifyingContract does not match the sponsored token',
    };
  }

  const { from, to } = messageFields;
  if (typeof from !== 'string' || !ethers.utils.isAddress(from)) {
    return { ok: false, reason: 'typedData.message.from must be an address' };
  }
  if (typeof to !== 'string' || !ethers.utils.isAddress(to)) {
    return { ok: false, reason: 'typedData.message.to must be an address' };
  }

  const value = toBigNumber(messageFields.value);
  const validAfter = toBigNumber(messageFields.validAfter);
  const validBefore = toBigNumber(messageFields.validBefore);
  if (!value || !validAfter || !validBefore) {
    return {
      ok: false,
      reason: 'typedData.message value/validAfter/validBefore must be non-negative integers',
    };
  }
  if (!isHex32(messageFields.nonce)) {
    return { ok: false, reason: 'typedData.message.nonce must be a 32-byte hex string' };
  }

  // Reject authorizations that are not currently valid, before paying to learn
  // the same thing from a reverted transaction.
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!validAfter.lt(nowSeconds)) {
    return { ok: false, reason: 'Authorization is not yet valid' };
  }
  if (!validBefore.gt(nowSeconds)) {
    return { ok: false, reason: 'Authorization has expired' };
  }

  const authorization: ValidatedAuthorization = {
    from: ethers.utils.getAddress(from),
    to: ethers.utils.getAddress(to),
    value,
    validAfter,
    validBefore,
    nonce: messageFields.nonce,
    signature,
    sponsoredInfo,
  };

  // Recover the signer locally. This is the single most important check: it
  // proves the authorization was actually produced by `from` for this exact
  // domain and struct, rather than being an arbitrary blob the relayer would
  // have paid to submit and watch revert.
  let recovered: string;
  try {
    recovered = ethers.utils.verifyTypedData(
      {
        name: domainFields.name as string | undefined,
        version: domainFields.version as string | undefined,
        chainId,
        verifyingContract: ethers.utils.getAddress(verifyingContract),
      },
      TRANSFER_WITH_AUTHORIZATION_TYPES,
      {
        from: authorization.from,
        to: authorization.to,
        value: authorization.value,
        validAfter: authorization.validAfter,
        validBefore: authorization.validBefore,
        nonce: authorization.nonce,
      },
      signature,
    );
  } catch {
    return { ok: false, reason: 'Signature could not be verified' };
  }

  if (ethers.utils.getAddress(recovered) !== authorization.from) {
    return { ok: false, reason: 'Signature does not match typedData.message.from' };
  }

  return { ok: true, value: authorization };
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<SponsoredRelayResponse>,
) {
  // `applyCors` writes its own response when the origin is rejected or the
  // middleware fails, and reports `false` so no second write is attempted.
  if (!(await applyCors(req, res))) {
    return;
  }

  if (req.method !== 'POST') {
    // The original code returned `res.status(500)` without a body, which never
    // ends the response: the client hung until its own timeout.
    res.setHeader('Allow', ['POST']);
    res.status(405).json({ message: `Method ${req.method} Not Allowed` });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const { uuid, verificationCode } = body;

  if (typeof uuid !== 'string' || uuid.length === 0) {
    res.status(400).json({ message: 'uuid is required' });
    return;
  }
  if (typeof verificationCode !== 'string' || verificationCode.length === 0) {
    res.status(400).json({ message: 'verificationCode is required' });
    return;
  }

  try {
    // Authorize before doing any work. Possession of the out-of-band verification
    // code is what distinguishes the payer from an anonymous caller; without this
    // gate the endpoint sponsored gas, and wrote arbitrary transaction hashes,
    // for anyone on the internet.
    const payment = await authorizePayment(uuid, verificationCode);
    if (!payment) {
      // A missing record and a bad code return the same response so the endpoint
      // cannot be used to discover which uuids exist.
      res.status(403).json({ message: 'Invalid payment reference or verification code' });
      return;
    }

    // Path 1: the client broadcast the transaction itself and is reporting the
    // resulting hash.
    const reportedTxHash = body.txHash;
    if (reportedTxHash !== undefined) {
      if (!isHex32(reportedTxHash)) {
        res.status(400).json({ message: 'txHash must be a 32-byte hex string' });
        return;
      }

      const stored = await appendTxHashToPayment(uuid, reportedTxHash, verificationCode);
      if (!stored) {
        // Set-once semantics: a hash is already recorded for this payment.
        res.status(409).json({ message: 'A transaction hash is already recorded' });
        return;
      }

      res.status(200).json({ data: { txHash: reportedTxHash } });
      return;
    }

    // Path 2: sponsored relay. Validate the authorization completely before
    // spending any gas on it.
    const validation = validateAuthorization(body);
    if (!validation.ok) {
      res.status(400).json({ message: validation.reason });
      return;
    }
    const authorization = validation.value;

    // Bind the authorization to the stored payment. The record fixes which chain
    // the payment was created for, so a code captured for a cheap payment cannot
    // be replayed to sponsor a transaction on a different chain.
    if (String(payment.chainId) !== String(authorization.sponsoredInfo.chainId)) {
      res.status(400).json({ message: 'Authorization chain does not match the payment record' });
      return;
    }

    const mnemonic = process.env.PAYMASTER_MNEMONIC;
    const paymasterAddress = process.env.PAYMASTER_ADDRESS;
    if (!mnemonic || !paymasterAddress || !ethers.utils.isAddress(paymasterAddress)) {
      // Fail closed and loudly on misconfiguration instead of throwing a
      // non-null-assertion TypeError deep inside the request path.
      console.error('submitPaymentTx: PAYMASTER_MNEMONIC/PAYMASTER_ADDRESS are not configured');
      res.status(503).json({ message: 'Sponsorship is not configured' });
      return;
    }

    const provider = new ethers.providers.JsonRpcProvider(authorization.sponsoredInfo.rpc);
    const contract = new ethers.Contract(
      authorization.sponsoredInfo.fiatTokenAddress,
      fiatTokenAbi,
      provider,
    );

    const { v, r, s } = ethers.utils.splitSignature(authorization.signature);
    const txParams = [
      authorization.from,
      authorization.to,
      authorization.value,
      authorization.validAfter,
      authorization.validBefore,
      authorization.nonce,
      v,
      r,
      s,
    ] as const;

    const estimatedGasLimit = await contract.estimateGas.transferWithAuthorization(...txParams);
    if (estimatedGasLimit.gt(MAX_GAS_LIMIT)) {
      res.status(400).json({ message: 'Transaction exceeds the sponsored gas limit' });
      return;
    }

    const tx = await contract.populateTransaction.transferWithAuthorization(...txParams);

    // EIP-1559 fees. The original code set `tx.gasPrice` under a comment reading
    // "1559tx config", which produced a legacy type-0 transaction with no fee
    // ceiling at all.
    const feeData = await provider.getFeeData();
    const maxFeeCap = ethers.utils.parseUnits(String(MAX_FEE_PER_GAS_GWEI), 'gwei');
    const suggestedMaxFee = feeData.maxFeePerGas ?? feeData.gasPrice;
    if (!suggestedMaxFee) {
      res.status(503).json({ message: 'Could not determine current gas fees' });
      return;
    }
    if (suggestedMaxFee.gt(maxFeeCap)) {
      res.status(503).json({ message: 'Current network fees exceed the sponsorship cap' });
      return;
    }

    tx.chainId = authorization.sponsoredInfo.chainId;
    tx.gasLimit = estimatedGasLimit;
    tx.type = 2;
    tx.maxFeePerGas = suggestedMaxFee;
    tx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? suggestedMaxFee;
    delete tx.gasPrice;

    // Allocate the nonce and broadcast under the process-wide lock so concurrent
    // requests cannot be assigned the same nonce.
    const txSubmission = await serializeSubmission(async () => {
      tx.nonce = await provider.getTransactionCount(paymasterAddress, 'pending');
      const signer = ethers.Wallet.fromMnemonic(mnemonic).connect(provider);
      const signedTx = await signer.signTransaction(tx);
      return provider.sendTransaction(signedTx);
    });

    // Record the hash. A failure here is not fatal to the payer: the transaction
    // is already on the network.
    const recorded = await appendTxHashToPayment(uuid, txSubmission.hash, verificationCode);
    if (!recorded) {
      console.warn(`submitPaymentTx: could not record hash for payment ${uuid}`);
    }

    res.status(200).json({ data: txSubmission });
  } catch (error) {
    // Log the detail server-side; return an opaque message. Echoing
    // `err.message` leaked RPC endpoints, revert reasons and provider internals,
    // and the previous handler returned HTTP 200 alongside the error so clients
    // could not tell success from failure.
    console.error('submitPaymentTx failed:', error);
    res.status(502).json({ message: 'Error submitting transaction' });
  }
}
