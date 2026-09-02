/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextApiRequest, NextApiResponse } from 'next';
import handler from '@pages/api/paymentTxParams/index';
import { getPrismaClient } from '@helpers/database';
import { mockConsoleOutput } from '@tests/testHelpers';

jest.mock('@/helpers/database', () => ({
  getPrismaClient: jest.fn(),
}));

mockConsoleOutput();

type Params = {
  method?: string;
  body?: any;
  headers?: Record<string, string>;
  shouldFail?: boolean;
}

/** Stand-in for the server-generated code the create path stores. */
const GENERATED_CODE = 'kQ3rT9xB1mV7pL2sD8wY';

const run = async ({ method, body, headers, shouldFail = false }: Params = {}) => {
  // `headers` is supplied because the CORS layer is no longer `origin: '*'`: it
  // inspects the request origin, so the request mock has to carry a headers bag.
  const mockReq: Partial<NextApiRequest> = { method, body, headers: headers ?? {} };
  const mockRes: Partial<NextApiResponse> = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    setHeader: jest.fn(),
    // `getHeader` is required by the `Vary` handling inside the `cors` package
    // once a dynamic origin callback is configured.
    getHeader: jest.fn().mockReturnValue(undefined),
    end: jest.fn(),
  };
  const mockPrismaClient = {
    contactlessPaymentTxOrMsg: {
      create: shouldFail
        ? jest.fn().mockRejectedValue(new Error('Database error'))
        : jest.fn().mockImplementation(({ data }: any) =>
            Promise.resolve({
              ...data,
              uuid: 'generated-uuid',
              // The service always generates this server-side; the mock echoes a
              // fixed value so the response contract can be asserted.
              verificationCode: GENERATED_CODE,
            }),
          ),
    },
  };
  (getPrismaClient as jest.Mock).mockReturnValue(mockPrismaClient);

  await handler(mockReq as NextApiRequest, mockRes as NextApiResponse);

  return { mockReq, mockRes, mockPrismaClient };
};

describe('POST /api/paymentTxParams', () => {
  it('should create a new payment transaction', async () => {
    const body = {
      chainId: 1,
      dappUrl: 'https://dapp.com',
      dappName: 'Dapp Name',
      payloadType: 'eip681',
      contractAddress: '0xUsdcOnbaseAddress',
      toAddress: '0x1234567890123456789012345678901234567890',
      value: '1000000000000000000',
    };

    const { mockRes } = await run({ method: 'POST', body });

    expect(mockRes.status).toHaveBeenCalledWith(201);
    // The verification code is now returned here, exactly once, to the creator of
    // the payment request. Previously it was omitted from this response and the
    // unauthenticated GET-by-uuid route leaked it instead, which meant possession
    // of the code proved nothing.
    expect(mockRes.json).toHaveBeenCalledWith({
      message: 'Payment relay stored successfully',
      uuid: 'generated-uuid',
      verificationCode: GENERATED_CODE,
    });
  });

  it('should ignore a client-supplied uuid and verification code', async () => {
    const body = {
      uuid: 'attacker-chosen-uuid',
      verificationCode: '001',
      chainId: 8453,
      payloadType: 'eip681',
      contractAddress: '0xUsdcOnbaseAddress',
      toAddress: '0x1234567890123456789012345678901234567890',
      value: '1000000000000000000',
    };

    const { mockRes, mockPrismaClient } = await run({ method: 'POST', body });

    expect(mockRes.status).toHaveBeenCalledWith(201);
    const { data } = mockPrismaClient.contactlessPaymentTxOrMsg.create.mock.calls[0][0];
    // A client-chosen primary key made records squattable, and a client-chosen
    // code (the fixtures used '001') made the payment authorization guessable.
    expect(data.uuid).not.toBe('attacker-chosen-uuid');
    expect(data.verificationCode).not.toBe('001');
    expect(data.verificationCode).toHaveLength(20);
  });

  it('should normalise a numeric chainId to a decimal string', async () => {
    const body = {
      chainId: 8453,
      payloadType: 'eip681',
      contractAddress: '0xUsdcOnbaseAddress',
      toAddress: '0x1234567890123456789012345678901234567890',
      value: '1000000000000000000',
    };

    const { mockRes, mockPrismaClient } = await run({ method: 'POST', body });

    expect(mockRes.status).toHaveBeenCalledWith(201);
    const { data } = mockPrismaClient.contactlessPaymentTxOrMsg.create.mock.calls[0][0];
    // The `chainId` column is `String`, and the value selects which sponsor
    // configuration the submit route uses, so it is canonicalised on the way in.
    expect(data.chainId).toBe('8453');
  });

  it('should return 400 for a malformed chainId', async () => {
    const body = {
      chainId: 'not-a-chain',
      payloadType: 'eip681',
      contractAddress: '0xUsdcOnbaseAddress',
      toAddress: '0x1234567890123456789012345678901234567890',
      value: '1000000000000000000',
    };

    const { mockRes, mockPrismaClient } = await run({ method: 'POST', body });

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({
      message: 'chainId must be a non-negative integer',
    });
    expect(mockPrismaClient.contactlessPaymentTxOrMsg.create).not.toHaveBeenCalled();
  });

  it('should return 400 for a dappUrl with a non-http scheme', async () => {
    const body = {
      chainId: 8453,
      dappUrl: 'javascript:alert(1)',
      payloadType: 'eip681',
      contractAddress: '0xUsdcOnbaseAddress',
      toAddress: '0x1234567890123456789012345678901234567890',
      value: '1000000000000000000',
    };

    const { mockRes } = await run({ method: 'POST', body });

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({ message: 'dappUrl must use http or https' });
  });

  it('should handle errors when creating a payment transaction', async () => {
    const body = {
      chainId: 1,
      dappUrl: 'https://dapp.com',
      dappName: 'Dapp Name',
      payloadType: 'eip681',
      contractAddress: '0xUsdcOnbaseAddress',
      toAddress: '0x1234567890123456789012345678901234567890',
      value: '1000000000000000000',
    };

    const { mockRes } = await run({ method: 'POST', body, shouldFail: true });

    expect(mockRes.status).toHaveBeenCalledWith(500);
    // The underlying error is logged server-side and no longer interpolated into
    // the response, which previously disclosed database diagnostics.
    expect(mockRes.json).toHaveBeenCalledWith({
      message: 'Error storing payment transaction params',
    });
  });

  it('should return 405 for non-POST methods', async () => {
    const { mockRes } = await run({ method: 'GET', body: {} });

    expect(mockRes.setHeader).toHaveBeenCalledWith('Allow', ['POST']);
    expect(mockRes.status).toHaveBeenCalledWith(405);
    expect(mockRes.end).toHaveBeenCalledWith('Method GET Not Allowed');
  });

  describe('Param validation', () => {
    it('should return 400 for invalid payload type', async () => {
      const body = {
        chainId: 1,
        dappUrl: 'https://dapp.com',
        dappName: 'Dapp Name',
        payloadType: 'invalid',
      };

      const { mockRes } = await run({ method: 'POST', body });

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        message: 'Invalid or missing payload type',
      });
    });

    it('should reject a payload whose params do not match its declared type', async () => {
      const body = {
        chainId: 8453,
        dappUrl: 'https://dapp.com',
        dappName: 'Dapp Name',
        payloadType: 'contractCall', // we're passing wrong params for this payload type
        contractAddress: '0xUsdcOnbaseAddress',
        toAddress: '0x1234567890123456789012345678901234567890',
        value: '1000000000000000000',
      };

      const { mockRes } = await run({ method: 'POST', body });

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({
        message: 'Error storing payment transaction params',
      });
    });
  });
});
