import { getPaymentTxOrMsg } from '@/services/paymentTxOrMsgService';
import { getPrismaClient } from '@helpers/database';

jest.mock('@helpers/database', () => ({
  getPrismaClient: jest.fn(),
}));

describe('getPaymentTxOrMsg', () => {
  const mockUuid = 'test-uuid';
  const mockPaymentTxOrMsg = {
    uuid: mockUuid,
    verificationCode: 'abc123',
    chainId: '1',
    dappUrl: 'https://example.com',
    dappName: 'Test Dapp',
    payloadType: 'eip681',
    txParams: {
      contractAddress: '0x1234567890123456789012345678901234567890',
      toAddress: '0x0987654321098765432109876543210987654321',
      value: '1000000000000000000',
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };


  it('should retrieve and flatten a payment transaction or message', async () => {
    const mockPrismaClient = {
      contactlessPaymentTxOrMsg: {
        findUnique: jest.fn().mockResolvedValue(mockPaymentTxOrMsg),
      },
    };
    (getPrismaClient as jest.Mock).mockReturnValue(mockPrismaClient);

    const result = await getPaymentTxOrMsg(mockUuid);

    expect(mockPrismaClient.contactlessPaymentTxOrMsg.findUnique).toHaveBeenCalledWith({
      where: { uuid: mockUuid },
    });

    // `verificationCode` is deliberately absent. It is the secret that authorizes
    // submitting a sponsored transaction for this payment, and this read path is
    // reachable by anyone who knows the uuid. The previous assertion required the
    // code to be present in the response, which made it worthless as a factor.
    expect(result).toEqual({
      uuid: mockUuid,
      chainId: '1',
      dappUrl: 'https://example.com',
      dappName: 'Test Dapp',
      payloadType: 'eip681',
      contractAddress: '0x1234567890123456789012345678901234567890',
      toAddress: '0x0987654321098765432109876543210987654321',
      value: '1000000000000000000',
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
    expect(result).not.toHaveProperty('verificationCode');
  });

  it('should throw an error if the payment transaction or message is not found', async () => {
    const mockPrismaClient = {
      contactlessPaymentTxOrMsg: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    (getPrismaClient as jest.Mock).mockReturnValue(mockPrismaClient);

    await expect(getPaymentTxOrMsg(mockUuid)).rejects.toThrow('Payment transaction or message not found');
  });

  it('should handle database errors', async () => {
    const mockPrismaClient = {
      contactlessPaymentTxOrMsg: {
        findUnique: jest.fn().mockRejectedValue(new Error('Database error')),
      },
    };
    (getPrismaClient as jest.Mock).mockReturnValue(mockPrismaClient);

    await expect(getPaymentTxOrMsg(mockUuid)).rejects.toThrow('Database error');
  });
});