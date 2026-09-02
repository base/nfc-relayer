/* eslint-disable @typescript-eslint/no-explicit-any */
import { mockConsoleOutput } from '@tests/testHelpers';
import { cleanupOldPayments } from '@helpers/cleanup-payments';
import { getPrismaClient } from '@helpers/database';

jest.mock('@helpers/database', () => ({
  getPrismaClient: jest.fn(),
}));

mockConsoleOutput();

describe('cleanupOldPayments', () => {
  const mockDeleteMany = jest.fn();
  const mockPrismaClient = {
    contactlessPaymentTxOrMsg: {
      deleteMany: mockDeleteMany,
    },
    $disconnect: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (getPrismaClient as jest.Mock).mockReturnValue(mockPrismaClient);
  });

  it('should delete old payment transactions', async () => {
    mockDeleteMany.mockResolvedValue({ count: 5 });

    const result = await cleanupOldPayments();

    expect(result).toBe(5);
    expect(mockDeleteMany).toHaveBeenCalledWith({
      where: {
        createdAt: {
          lt: expect.any(Date),
        },
      },
    });
    // `$disconnect` must NOT be called. `getPrismaClient` returns a process-wide
    // singleton shared with every request handler, so disconnecting from a cron
    // handler tears the connection pool out from under concurrent requests. The
    // previous assertion required that behaviour.
    expect(mockPrismaClient.$disconnect).not.toHaveBeenCalled();
  });

  it('should rethrow database errors without disconnecting the shared client', async () => {
    const error = new Error('Database error');
    mockDeleteMany.mockRejectedValue(error);

    await expect(cleanupOldPayments()).rejects.toThrow('Database error');
    expect(mockPrismaClient.$disconnect).not.toHaveBeenCalled();
  });
});