jest.mock('./extensions/authentication.extension', () => ({
  AuthenticationExtension: class {},
}));
jest.mock('./extensions/persistence.extension', () => ({
  PersistenceExtension: class {},
}));
jest.mock('../common/helpers', () => ({
  parseRedisUrl: () => ({}),
  createRetryStrategy: jest.fn(),
}));

import { CollaborationGateway } from './collaboration.gateway';

describe('CollaborationGateway direct edits', () => {
  afterEach(() => jest.restoreAllMocks());
  const context = { user: { id: 'author' } } as any;

  it('disconnects even when editing or persistence fails', async () => {
    const gateway = new CollaborationGateway(
      {} as any,
      {} as any,
      {} as any,
      {
        getRedisUrl: () => '',
        isCollabDisableRedis: () => true,
        getCollabUrl: () => '',
      } as any,
    );
    const connection = {
      transact: jest.fn().mockRejectedValue(new Error('store failed')),
      disconnect: jest.fn(),
    };
    const open = jest
      .spyOn((gateway as any).hocuspocus, 'openDirectConnection')
      .mockResolvedValue(connection);
    try {
      await expect(
        gateway.withYdocConnection('page.id', context, jest.fn()),
      ).rejects.toThrow('store failed');
      expect(open).toHaveBeenCalledWith('page.id', context);
      expect(connection.disconnect).toHaveBeenCalledTimes(1);
    } finally {
      await gateway.destroy();
    }
  });

  it('rejects edits when a separate collab process cannot receive them', async () => {
    const gateway = new CollaborationGateway(
      {} as any,
      {} as any,
      {} as any,
      {
        getRedisUrl: () => '',
        isCollabDisableRedis: () => true,
        getCollabUrl: () => 'wss://example.test/collab',
      } as any,
    );
    const open = jest.spyOn(
      (gateway as any).hocuspocus,
      'openDirectConnection',
    );
    try {
      await expect(
        gateway.withYdocConnection('page.id', context, jest.fn()),
      ).rejects.toThrow('require Redis synchronization');
      expect(open).not.toHaveBeenCalled();
    } finally {
      await gateway.destroy();
    }
  });
});
