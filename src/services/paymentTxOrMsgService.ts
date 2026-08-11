import { getPrismaClient } from '@helpers/database';
import { v4 as uuidv4 } from 'uuid';
import { Prisma } from '@prisma/client';
import { Payload } from '@/types/paymentTx';
import { formatTxMessageResponse } from '@/helpers/formatTxMessageResponse';
import { formatTxDataResponse } from '@/helpers/formatTxDataResponse';

/**
 * Creates and stores a new payment transaction or message payload in the database.
 * Routes the payload data into specific JSON structures based on its type (EIP-681, Contract Call, or EIP-712).
 * 
 * [SECURITY PATCH]: Removed client-controlled `uuid` to prevent primary key poisoning / IDOR injection. 
 * The server is now the sole namer of records. Dropped the insecure `verificationCode` column entirely.
 * 
 * @param {Payload} payload - The transaction or message payload data.
 * @returns {Promise<any>} The created database record containing the server-generated UUID and formatted parameters.
 * @throws {Error} If the provided payload type is not recognized.
 */
export const createPaymentTxOrMsg = async (payload: Payload) => {
  const prisma = getPrismaClient();

  // [SECURITY PATCH]: Server-generated UUID only. Ignored any client-supplied `uuid` fields.
  const paymentUuid = uuidv4();

  // Extract base data common across all payload types (omitting verificationCode)
  const baseData = {
    uuid: paymentUuid,
    chainId: payload.chainId,
    dappUrl: payload.dappUrl,
    dappName: payload.dappName,
    payloadType: payload.payloadType,
    additionalPayload: payload.additionalPayload ?? Prisma.DbNull,
    rpcProxySubmissionParams: payload.rpcProxySubmissionParams ?? Prisma.DbNull,
  };

  let txParams: Prisma.JsonValue;

  // Route and format the transaction parameters based on the specific EIP or contract payload type
  // Using explicit structure check instead of throwing type-guard functions
  switch (payload.payloadType) {
    case 'eip681':
      txParams = {
        contractAddress: payload.contractAddress,
        toAddress: payload.toAddress,
        value: payload.value,
      };
      break;
    case 'contractCall':
      txParams = {
        requiresSenderAddress: payload.requiresSenderAddress,
        contractAbi: payload.contractAbi,
        placeholderSenderAddress: payload.placeholderSenderAddress,
        approveTxs: payload.approveTxs,
        paymentTx: payload.paymentTx,
      };
      break;
    case 'eip712':
      // Typed structured data signing. Stored within rpcProxySubmissionParams.
      txParams = {};
      break;
    default:
      throw new Error('Invalid or unsupported payload type provided.');
  }

  // Persist the combined base data and type-specific JSON parameters
  return prisma.contactlessPaymentTxOrMsg.create({
    data: {
      ...baseData,
      txParams,
    },
  });
};

/**
 * Retrieves a payment transaction or message by its UUID and formats the output.
 * Uses an explicit select allowlist to prevent data leakage and flattens the nested `txParams`.
 * 
 * @param {string} uuid - The unique identifier of the payment transaction.
 * @param {string} [senderAddress] - The optional sender address to bind to the formatting helpers.
 * @returns {Promise<any>} The flattened and formatted transaction/message data.
 * @throws {Error} If no record matches the provided UUID.
 */
export const getPaymentTxOrMsg = async (uuid: string, senderAddress?: string) => {
  const prisma = getPrismaClient();

  // [SECURITY PATCH]: Explicit select allowlist to prevent accidental leakage of internal columns
  const paymentTxOrMsg = await prisma.contactlessPaymentTxOrMsg.findUnique({
    where: { uuid },
    select: {
      uuid: true,
      payloadType: true,
      chainId: true,
      txParams: true,
      rpcProxySubmissionParams: true,
      additionalPayload: true,
      dappName: true,
      dappUrl: true,
      txHash: true,
      createdAt: true,
    },
  });

  if (!paymentTxOrMsg) {
    throw new Error(`Payment transaction or message not found for UUID: ${uuid}`);
  }

  // Destructure to separate the nested JSON parameters from the base record
  const { txParams, ...rest } = paymentTxOrMsg;
  const flattenedTxParams = (txParams as Record<string, unknown>) ?? {};

  // Route the formatting based on the payload type
  if (paymentTxOrMsg.payloadType === 'eip712') {
    return formatTxMessageResponse({
      txMessage: {
        ...rest,
        ...flattenedTxParams,
      },
      senderAddress,
    });
  }

  if (paymentTxOrMsg.payloadType === 'contractCall') {
    return formatTxDataResponse({
      txData: {
        ...rest,
        ...flattenedTxParams,
      },
      senderAddress,
    });
  }

  // Fallback return for eip681 or other unformatted types, returning the flattened object
  return {
    ...rest,
    ...flattenedTxParams,
  };
};

/**
 * Appends an on-chain transaction hash to an existing payment record.
 * 
 * [SECURITY PATCH]: Note that this function is strictly used internally by the server-side 
 * relay path (`submitPaymentTx`). Client-side direct updates have been completely stripped 
 * to eliminate IDOR write vulnerabilities.
 * 
 * @param {string} uuid - The unique identifier of the payment transaction.
 * @param {string} txHash - The resulting transaction hash from the blockchain network.
 * @returns {Promise<any>} The updated database record.
 */
export const appendTxHashToPayment = async (uuid: string, txHash: string) => {
  const prisma = getPrismaClient();

  return prisma.contactlessPaymentTxOrMsg.update({
    where: { uuid },
    data: {
      txHash,
    },
  });
};