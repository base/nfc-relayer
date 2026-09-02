import { NextApiRequest, NextApiResponse } from 'next';
import handler from '@pages/api/paymentTxParams/[uuid]';
import { getPrismaClient } from '@helpers/database';
import { mockConsoleOutput } from '@tests/testHelpers';

jest.mock('@/helpers/database', () => ({
  getPrismaClient: jest.fn(),
}));

mockConsoleOutput();

type Params = {
  method?: string;
  query?: any;
  headers?: Record<string, string>;
  response?: Record<string, unknown> | null;
  shouldFail?: boolean;
};

/**
 * A valid RFC 4122 v4 identifier.
 *
 * The route now rejects anything that is not a canonical UUID, so the fixtures
 * below use real identifiers. The previous fixtures used `'test-uuid'`, which
 * only reached the database because no shape validation existed.
 */
const VALID_UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const OTHER_VALID_UUID = '9f1b7c2a-1d3e-4b5c-8a7d-2e4f6a8b0c1d';

const run = async ({ method, query, headers, response, shouldFail = false }: Params = {}) => {
  // `headers` is supplied because the CORS layer is no longer `origin: '*'`: it
  // inspects the request origin, so the request mock has to carry a headers bag.
  const mockReq: Partial<NextApiRequest> = { method, query, headers: headers ?? {} };
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
      findUnique: shouldFail
        ? jest.fn().mockRejectedValue(new Error('Database error'))
        : jest.fn().mockResolvedValue(response),
    },
  };
  (getPrismaClient as jest.Mock).mockReturnValue(mockPrismaClient);

  await handler(mockReq as NextApiRequest, mockRes as NextApiResponse);

  return { mockReq, mockRes, mockPrismaClient };
};

const mockPaymentTx = {
  uuid: VALID_UUID,
  toAddress: '0x1234567890123456789012345678901234567890',
  chainId: 1,
  value: '1000000000000000000',
  contractAddress: 'contract123',
};

describe('GET /api/paymentTxParams/[uuid]', () => {
  it('should retrieve a payment transaction by UUID', async () => {
    const { mockRes } = await run({
      method: 'GET',
      query: { uuid: VALID_UUID },
      response: mockPaymentTx,
    });

    expect(mockRes.status).toHaveBeenCalledWith(200);
    expect(mockRes.json).toHaveBeenCalledWith(mockPaymentTx);
  });

  it('should never include the verification code in the response', async () => {
    const { mockRes } = await run({
      method: 'GET',
      query: { uuid: VALID_UUID },
      response: { ...mockPaymentTx, verificationCode: 'super-secret-code' },
    });

    expect(mockRes.status).toHaveBeenCalledWith(200);
    const body = (mockRes.json as jest.Mock).mock.calls[0][0];
    expect(body).not.toHaveProperty('verificationCode');
    expect(JSON.stringify(body)).not.toContain('super-secret-code');
  });

  it('should return 500 with an opaque message when the payment is not found', async () => {
    const { mockRes } = await run({
      method: 'GET',
      query: { uuid: OTHER_VALID_UUID },
      response: null,
    });

    expect(mockRes.status).toHaveBeenCalledWith(500);
    // The message no longer interpolates the underlying error. Echoing it told an
    // unauthenticated caller whether a uuid existed, which turns this route into a
    // uuid oracle, and disclosed Prisma internals on other failures.
    expect(mockRes.json).toHaveBeenCalledWith({
      message: 'Error retrieving payment transaction',
    });
  });

  it('should return 400 for a non-string UUID', async () => {
    const { mockRes } = await run({ method: 'GET', query: { uuid: [VALID_UUID] } });

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({ message: 'Invalid UUID' });
  });

  it('should return 400 for a malformed UUID without querying the database', async () => {
    const { mockRes, mockPrismaClient } = await run({
      method: 'GET',
      query: { uuid: 'not-a-uuid' },
    });

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({ message: 'Invalid UUID' });
    expect(mockPrismaClient.contactlessPaymentTxOrMsg.findUnique).not.toHaveBeenCalled();
  });

  it('should handle errors when retrieving a payment transaction', async () => {
    const { mockRes } = await run({
      method: 'GET',
      query: { uuid: VALID_UUID },
      shouldFail: true,
    });

    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(mockRes.json).toHaveBeenCalledWith({
      message: 'Error retrieving payment transaction',
    });
  });

  it('should return 405 for non-GET methods', async () => {
    const { mockRes } = await run({ method: 'POST', query: { uuid: VALID_UUID } });

    expect(mockRes.setHeader).toHaveBeenCalledWith('Allow', ['GET']);
    expect(mockRes.status).toHaveBeenCalledWith(405);
    expect(mockRes.end).toHaveBeenCalledWith('Method POST Not Allowed');
  });

  it('should return 400 for invalid sender address', async () => {
    const { mockRes } = await run({
      method: 'GET',
      query: {
        uuid: VALID_UUID,
        senderAddress: 'invalid-address',
      },
      response: mockPaymentTx,
    });

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({ message: 'Invalid sender address' });
  });
});
