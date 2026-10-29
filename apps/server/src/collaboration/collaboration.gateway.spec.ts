jest.mock('./extensions/authentication.extension', () => ({
  AuthenticationExtension: class {},
}));
jest.mock('./extensions/persistence.extension', () => ({
  PersistenceExtension: class {},
}));
jest.mock('@hocuspocus/extension-redis', () => ({ Redis: class {} }));
jest.mock('../common/helpers', () => ({
  parseRedisUrl: () => ({}),
  createRetryStrategy: jest.fn(),
}));

import * as Y from 'yjs';
import { Hocuspocus } from '@hocuspocus/server';
import { ServiceUnavailableException } from '@nestjs/common';
import { CollaborationGateway } from './collaboration.gateway';

describe('CollaborationGateway direct edits', () => {
  const context = { user: { id: 'author' } };
  let gateway: CollaborationGateway;
  let server: Hocuspocus;
  let saved: Buffer | undefined;
  let store: jest.Mock;

  beforeEach(() => {
    saved = undefined;
    store = jest.fn(async ({ document }) => {
      saved = Buffer.from(Y.encodeStateAsUpdate(document));
    });
    gateway = new CollaborationGateway(
      {} as any,
      {
        isDirectEditPersisted: (doc: Y.Doc) =>
          saved?.equals(Buffer.from(Y.encodeStateAsUpdate(doc))) ?? false,
      } as any,
      {} as any,
      {
        getRedisUrl: () => '',
        isCollabDisableRedis: () => true,
        getCollabUrl: () => '',
      } as any,
    );
    server = new Hocuspocus({
      unloadImmediately: false,
      extensions: [{ onStoreDocument: store }],
    });
    (gateway as any).hocuspocus = server;
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    await gateway.destroy();
    jest.restoreAllMocks();
  });

  const change = (doc: Y.Doc) => doc.getText('test').insert(0, 'new body');

  it('retries swallowed lock conflicts without applying the edit again', async () => {
    store.mockRejectedValueOnce(undefined).mockRejectedValueOnce(undefined);
    const edit = jest.fn(change);
    await gateway.withYdocConnection('page.id', context, edit);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(store).toHaveBeenCalledTimes(4); // 3 attempts + normal disconnect
    const restored = new Y.Doc();
    Y.applyUpdate(restored, saved!);
    expect(restored.getText('test').toString()).toBe('new body');
    restored.destroy();
  });

  it.each(['skipped', 'failed'])(
    'keeps a confirmed write successful when the redundant disconnect store is %s',
    async (outcome) => {
      store
        .mockImplementationOnce(async ({ document }) => {
          saved = Buffer.from(Y.encodeStateAsUpdate(document));
        })
        .mockRejectedValueOnce(
          outcome === 'failed' ? new Error('database unavailable') : undefined,
        );
      await gateway.withYdocConnection('page.id', context, change);
      expect(saved).toBeDefined();
      expect(store).toHaveBeenCalledTimes(2);
      expect(gateway.getDocumentCount()).toBe(0);
    },
  );

  it('returns 503 after bounded skipped stores, unloads and lets destroy complete', async () => {
    store.mockRejectedValue(undefined); // Redis rejects with no Error; core swallows it.
    await expect(
      gateway.withYdocConnection('page.id', context, change),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(store).toHaveBeenCalledTimes(6);
    expect(saved).toBeUndefined();
    expect(gateway.getDocumentCount()).toBe(0);
    await gateway.destroy();
  });

  it('unloads after a database error without a cleanup store that could save later', async () => {
    store.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(
      gateway.withYdocConnection('page.id', context, change),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(store).toHaveBeenCalledTimes(1);
    expect(saved).toBeUndefined();
    expect(gateway.getDocumentCount()).toBe(0);
    await gateway.destroy();
  });

  it('releases and unloads when the edit callback throws', async () => {
    await expect(
      gateway.withYdocConnection('page.id', context, () => {
        throw new Error('invalid edit');
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(store).not.toHaveBeenCalled();
    expect(gateway.getDocumentCount()).toBe(0);
  });

  it('keeps a connected document live after failure; its next store can save the edit', async () => {
    // Another direct connection exercises the same connection-count guard as a browser.
    const browser = await server.openDirectConnection('page.id', context);
    store.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(
      gateway.withYdocConnection('page.id', context, change),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(gateway.getDocumentCount()).toBe(1);
    expect(browser.document!.getConnectionsCount()).toBe(1);
    expect(browser.document!.getText('test').toString()).toBe('new body');
    expect(saved).toBeUndefined();
    await browser.disconnect();
    expect(saved).toBeDefined();
  });

  it.each([true, false])(
    'rejects separate collab processes even with Redis (disabled: %s)',
    async (disabled) => {
      (gateway as any).environmentService = {
        getCollabUrl: () => 'wss://example.test/collab',
        isCollabDisableRedis: () => disabled,
      };
      const open = jest.spyOn(server, 'openDirectConnection');
      await expect(
        gateway.withYdocConnection('page.id', context, change),
      ).rejects.toThrow('COLLAB_URL must not be configured');
      expect(open).not.toHaveBeenCalled();
    },
  );
});
