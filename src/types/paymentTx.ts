/* eslint-disable @typescript-eslint/no-explicit-any */
export type PayloadType = 'eip681' | 'contractCall' | 'eip712';

export type BasePayload = {
  payloadType: PayloadType;
  // `uuid` is deliberately absent: the payment identifier is generated
  // server-side. Accepting it from the client let callers choose the primary key
  // of the record, which made stored payments enumerable and squattable.
  chainId: string;
  dappUrl?: string;
  dappName?: string;
  additionalPayload?: any;
  rpcProxySubmissionParams?: any;
};

export type Eip681Payload = BasePayload & {
  contractAddress: string;
  toAddress: string;
  value: string;
};

export type ContractCallPayload = BasePayload & {
  requiresSenderAddress?: boolean;
  placeholderSenderAddress?: string;
  contractAbi?: string;
  approveTxs?: any;
  paymentTx: any;
};

export type Eip712Payload = BasePayload & {
  message: string;
};

export type Payload = Eip681Payload | ContractCallPayload | Eip712Payload;

// Type guard functions
export function isEip681Payload(payload: Payload): payload is Eip681Payload {
  return (
    payload.payloadType === 'eip681' &&
    'contractAddress' in payload &&
    'toAddress' in payload &&
    'value' in payload
  );
}

export function isContractCallPayload(payload: Payload): payload is ContractCallPayload {
  return (
    payload.payloadType === 'contractCall' &&
    'paymentTx' in payload
  );
}

export function isEip712Payload(payload: Payload): payload is Eip712Payload {
  return payload.payloadType === 'eip712' && 'rpcProxySubmissionParams' in payload && 'typedData' in payload.rpcProxySubmissionParams;
}
