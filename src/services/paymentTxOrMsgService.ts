import { getPrismaClient } from '@helpers/database';
import { v4 as uuidv4 } from 'uuid';
import { generateRandomString } from '@helpers/generate-random-string';
import { Prisma } from '@prisma/client';
import {
  Payload,
  isEip681Payload,
  isContractCallPayload,
  isEip712Payload,
} from '@/types/paymentTx';
import { formatTxMessageResponse } from '@/helpers/formatTxMessageResponse';
import { formatTxDataResponse } from '@/helpers/formatTxDataResponse';

/**
 * Creates and stores a new payment transaction or message payload in the database.
 * Routes the payload data into specific JSON structures based on its type (EIP-681, Contract Call, or EIP-712).
 * 
 * @param {Payload} payload - The transaction or message payload data.
 * @returns {Promise<any>} The created database record containing the UUID and formatted transaction parameters.
 * @throws {Error} If the provided payload type is not recognized.
 */
export const createPaymentTxOrMsg = async (payload: Payload) => {
  const prisma = getPrismaClient();

  // Generate a unique identifier and verification code for the transaction session
  const paymentUuid = payload.uuid || uuidv4();
  const verificationCode = generateRandomString();

  // Extract base data common across all payload types
  const baseData = {
    uuid: paymentUuid,
    verificationCode,
    chainId: payload.chainId,
    dappUrl: payload.dappUrl,
    dappName: payload.dappName,
    payloadType: payload.payloadType,
    additionalPayload: payload.additionalPayload,
    rpcProxySubmissionParams: payload.rpcProxySubmissionParams,
  };

  let txParams: Prisma.JsonValue;

  // Route and format the transaction parameters based on the specific EIP or contract payload type
  if (isEip681Payload(payload)) {
    // Standard transaction request (e.g., native token transfers)
    txParams = {
      contractAddress: payload.contractAddress,
      toAddress: payload.toAddress,
      value: payload.value,
    };
  } else if (isContractCallPayload(payload)) {
    // Complex smart contract interactions requiring ABIs and potential approval txs
    txParams = {
      requiresSenderAddress: payload.requiresSenderAddress,
      contractAbi: payload.contractAbi,
      placeholderSenderAddress: payload.placeholderSenderAddress,
      approveTxs: payload.approveTxs,
      paymentTx: payload.paymentTx,
    };
  } else if (isEip712Payload(payload)) {
    // Typed structured data signing. 
    // The actual message to be signed is stored within `rpcProxySubmissionParams`.
    // TODO (Justin): Make this work for Slice integration
    txParams = {};
  } else {
    // Failsafe for unsupported or malformed payload structures
    throw new Error('Invalid payload type provided.');
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
 * Flattens the nested `txParams` JSON object into the root level of the returned object 
 * and applies specific formatting based on the payload type.
 * 
 * @param {string} uuid - The unique identifier of the payment transaction.
 * @param {string} [senderAddress] - The optional sender address to bind to the formatting helpers.
 * @returns {Promise<any>} The flattened and formatted transaction/message data.
 * @throws {Error} If no record matches the provided UUID.
 */
export const getPaymentTxOrMsg = async (uuid: string, senderAddress?: string) => {
  const prisma = getPrismaClient();

  // Fetch the raw record from the database
  const paymentTxOrMsg = await prisma.contactlessPaymentTxOrMsg.findUnique({
    where: { uuid },
  });

  if (!paymentTxOrMsg) {
    throw new Error(`Payment transaction or message not found for UUID: ${uuid}`);
  }

  // Destructure to separate the nested JSON parameters from the base record
  const { txParams, ...rest } = paymentTxOrMsg;
  
  // Cast txParams to a Record for safe spreading. 
  // (Assuming Prisma.JsonValue is an object in this context based on creation logic)
  const flattenedTxParams = txParams as Record<string, unknown>;

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
 * This is typically called after the client successfully submits the transaction to the RPC.
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