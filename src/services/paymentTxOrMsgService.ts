import { getPrismaClient } from '@helpers/database';
import { v4 as uuidv4 } from 'uuid';
import { generateRandomString } from '@helpers/generate-random-string';
import { secureCompare } from '@helpers/secure-compare';
import {
  Payload,
  isEip681Payload,
  isContractCallPayload,
  isEip712Payload,
} from '@/types/paymentTx';
import { Prisma } from '@prisma/client';
import { formatTxMessageResponse } from '@/helpers/formatTxMessageResponse';
import { formatTxDataResponse } from '@/helpers/formatTxDataResponse';

/**
 * Creates a payment record and returns it together with its verification code.
 *
 * The `uuid` is always generated server-side. Previously the implementation used
 * `payload.uuid || uuidv4()`, which let the client choose the primary key. A
 * client-chosen identifier lets an attacker pre-register or squat on a
 * predictable id and, combined with the unauthenticated read path, made records
 * enumerable.
 *
 * @param payload Caller-supplied payment description. Only the fields listed
 *   below are persisted; anything else in the object is discarded.
 * @returns The created row. The caller is responsible for deciding which fields
 *   are safe to return over the wire — see {@link toPublicPayment}.
 */
export const createPaymentTxOrMsg = async (payload: Payload) => {
  const prisma = getPrismaClient();

  // Server-generated identifier. Never derived from client input.
  const paymentUuid = uuidv4();
  const verificationCode = generateRandomString();

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

  if (isEip681Payload(payload)) {
    txParams = {
      contractAddress: payload.contractAddress,
      toAddress: payload.toAddress,
      value: payload.value,
    };
  } else if (isContractCallPayload(payload)) {
    txParams = {
      requiresSenderAddress: payload.requiresSenderAddress,
      contractAbi: payload.contractAbi,
      placeholderSenderAddress: payload.placeholderSenderAddress,
      approveTxs: payload.approveTxs,
      paymentTx: payload.paymentTx,
    };
  } else if (isEip712Payload(payload)) {
    // noop, rpcProxySubmissionParams contains the message needed to be signed and submitted
    // TODO (Justin): Make this work for Slice
    txParams = {};
  } else {
    throw new Error('Invalid payload type');
  }

  return prisma.contactlessPaymentTxOrMsg.create({
    data: {
      ...baseData,
      txParams,
    },
  });
};

/**
 * Strips server-only columns from a payment row before it leaves the process.
 *
 * `verificationCode` is the secret that authorizes submitting a sponsored
 * transaction for a payment. It was previously spread into every GET response via
 * `...rest`, so the unauthenticated read endpoint handed the secret to anyone who
 * knew the uuid — which made the code worthless as an out-of-band factor.
 */
function toPublicPayment<T extends { verificationCode?: string }>(row: T): Omit<T, 'verificationCode'> {
  // Destructure-to-omit: the binding exists only to keep the field out of the
  // rest object, so the unused-variable rule is disabled for this line alone.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { verificationCode: _verificationCode, ...publicFields } = row;
  return publicFields;
}

/**
 * Get a payment transaction or message by uuid. Flattens the txParams object.
 *
 * The returned object never includes `verificationCode`.
 */
export const getPaymentTxOrMsg = async (uuid: string, senderAddress?: string) => {
  const prisma = getPrismaClient();

  const paymentTxOrMsg = await prisma.contactlessPaymentTxOrMsg.findUnique({
    where: { uuid },
  });

  if (!paymentTxOrMsg) {
    throw new Error('Payment transaction or message not found');
  }

  // Remove the txParams prop and flatten, then drop server-only columns.
  const { txParams, ...rest } = toPublicPayment(paymentTxOrMsg);

  if (paymentTxOrMsg.payloadType === 'eip712') {
    return formatTxMessageResponse({
      txMessage: {
        ...rest,
        ...(txParams as Record<string, unknown>),
      },
      senderAddress,
    });
  }

  if (paymentTxOrMsg.payloadType === 'contractCall') {
    return formatTxDataResponse({
      txData: {
      ...rest,
      ...(txParams as Record<string, unknown>)
    },
    senderAddress,
  });
  }

  return {
    ...rest,
    ...(txParams as Record<string, unknown>),
  };
};

/**
 * Loads a payment record and checks the caller-supplied verification code.
 *
 * This is the authorization primitive for every mutating operation on a payment.
 * The code is delivered to the payer out of band (NFC tap or QR scan), so
 * possession of it — not merely knowledge of the uuid — is what proves the caller
 * is the intended party.
 *
 * @param uuid Payment identifier.
 * @param verificationCode Code presented by the caller.
 * @returns The record when the code matches, otherwise `null`. A missing record
 *   and a wrong code are deliberately indistinguishable to the caller so the
 *   endpoint cannot be used to enumerate valid uuids.
 */
export const authorizePayment = async (uuid: string, verificationCode: unknown) => {
  const prisma = getPrismaClient();

  const payment = await prisma.contactlessPaymentTxOrMsg.findUnique({
    where: { uuid },
  });

  if (!payment) {
    return null;
  }
  if (!secureCompare(payment.verificationCode, verificationCode)) {
    return null;
  }

  return payment;
};

/**
 * Records the broadcast transaction hash for a payment.
 *
 * Adding a tx hash is what tells the client the transaction was sent, so it is a
 * security-relevant write, not bookkeeping. Two guards apply:
 *
 *  - the caller must present the payment's `verificationCode`, and
 *  - the update is conditional on `txHash` still being null, so a hash can be
 *    written exactly once and a later caller cannot overwrite a real hash with a
 *    fabricated one.
 *
 * Both conditions are enforced inside a single `updateMany` predicate, which makes
 * the check-and-set atomic with respect to concurrent requests. The previous
 * implementation was an unconditional `update({ where: { uuid } })` reachable from
 * an unauthenticated endpoint, so anyone who knew a uuid could set an arbitrary
 * string as the confirmed hash.
 *
 * @returns `true` when the hash was stored, `false` when the code did not match
 *   or a hash was already present.
 */
export const appendTxHashToPayment = async (
  uuid: string,
  txHash: string,
  verificationCode: unknown,
): Promise<boolean> => {
  const prisma = getPrismaClient();

  // Constant-time code check first, so the outcome does not depend on how many
  // leading characters of the code were correct.
  const payment = await authorizePayment(uuid, verificationCode);
  if (!payment) {
    return false;
  }

  const result = await prisma.contactlessPaymentTxOrMsg.updateMany({
    where: { uuid, verificationCode: payment.verificationCode, txHash: null },
    data: { txHash },
  });

  return result.count === 1;
};