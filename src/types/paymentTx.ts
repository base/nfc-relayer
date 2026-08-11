export type PayloadType = 'eip681' | 'contractCall' | 'eip712';

// [SECURITY PATCH]: Replaced all `any` types with a strict, recursive JSON type.
// This allows us to remove the dangerous `eslint-disable @typescript-eslint/no-explicit-any` directive.
export type JsonValue = string | number | boolean | null | JsonValue[] | { readonly [k: string]: JsonValue };

interface PayloadBase {
  readonly chainId: string;
  readonly dappUrl?: string;
  readonly dappName?: string;
  readonly additionalPayload?: JsonValue; 
  // [SECURITY PATCH]: `uuid?: string` has been removed. 
  // The server must be the sole namer of records to prevent Client-Controlled Primary Key (IDOR) attacks.
}

// Strictly type the EIP-712 message structure we expect from the relayer
export interface TypedDataMessage {
  readonly from: string; 
  readonly to: string; 
  readonly value: string;
  readonly validAfter: string; 
  readonly validBefore: string; 
  readonly nonce: string;
}

export interface Eip681Payload extends PayloadBase {
  readonly payloadType: 'eip681';
  readonly contractAddress: string; 
  readonly toAddress: string; 
  readonly value: string;
}

export interface ContractCallPayload extends PayloadBase {
  readonly payloadType: 'contractCall';
  readonly paymentTx: JsonValue;
  readonly requiresSenderAddress?: boolean;
  readonly placeholderSenderAddress?: string;
  readonly contractAbi?: string;
  readonly approveTxs?: JsonValue;
}

export interface Eip712Payload extends PayloadBase {
  readonly payloadType: 'eip712';
  readonly rpcProxySubmissionParams: {
    readonly typedData: {
      readonly domain: { readonly chainId: number; readonly verifyingContract: string };
      readonly message: TypedDataMessage;
    };
  };
}

// [SECURITY PATCH]: Converted to a strict Discriminated Union keyed on `payloadType`.
export type Payload = Eip681Payload | ContractCallPayload | Eip712Payload;

/**
 * [SECURITY PATCH]: Replaces the unsafe `isEip681Payload`, `isContractCallPayload`, and `isEip712Payload` guards.
 * The old `isEip712Payload` evaluated `'typedData' in payload.rpcProxySubmissionParams`, which threw a 
 * TypeError (crashing the server) when that field was present but null. 
 * 
 * Instead of guards, use a `switch(payload.payloadType)` statement in your logic, and place this 
 * in the `default` case to ensure exhaustive type checking at compile time.
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled payload variant: ${JSON.stringify(value)}`);
}