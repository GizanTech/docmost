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
import { Hocuspocus, Server as HocuspocusServer } from '@hocuspocus/server';
import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
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
    server = new Hocuspocus({
      unloadImmediately: false,
      extensions: [{ onStoreDocument: store }],
    });
    jest.spyOn(HocuspocusServer, 'configure').mockReturnValue(server);
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
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    await gateway.destroy();
    jest.restoreAllMocks();
  });

  const change = (doc: Y.Doc) => doc.getText('test').insert(0, 'new body');

  it('keeps the newer document when Redis-like delayed stores unload the old one', async () => {
    jest.useFakeTimers();
    let pending: {
      timeout: ReturnType<typeof setTimeout>;
      resolve: () => void;
    };
    const afterStore = jest.fn(async ({ socketId }) => {
      if (socketId !== 'server') return;
      if (pending) {
        clearTimeout(pending.timeout);
        pending.resolve();
      }
      await new Promise<void>((resolve) => {
        pending = {
          resolve,
          timeout: setTimeout(() => {
            pending = undefined;
            resolve();
          }, 200),
        };
      });
    });
    server.configuration.extensions.push({ afterStoreDocument: afterStore });
    let reopened: Awaited<ReturnType<Hocuspocus['openDirectConnection']>>;
    let newer: Y.Doc;
    try {
      await gateway.withYdocConnection('page.id', context, change);
      await jest.advanceTimersByTimeAsync(0);
      const old = store.mock.calls[0][0].document;
      expect(afterStore).toHaveBeenCalledTimes(2);
      expect(server.documents.has('page.id')).toBe(false);
      reopened = await server.openDirectConnection('page.id', context);
      newer = reopened.document!;
      expect(newer).not.toBe(old);
      const destroyed = jest.fn();
      newer.on('destroy', destroyed);
      await jest.advanceTimersByTimeAsync(200);
      expect(server.documents.get('page.id')).toBe(newer);
      expect(destroyed).not.toHaveBeenCalled();
    } finally {
      await reopened?.disconnect();
      await jest.advanceTimersByTimeAsync(200);
      newer?.destroy();
      jest.useRealTimers();
    }
  });

  it('preserves callback HTTP errors and releases the failed connection', async () => {
    const error = new ForbiddenException('edit forbidden');
    await expect(
      gateway.withYdocConnection('page.id', context, () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(store).not.toHaveBeenCalled();
    expect(gateway.getDocumentCount()).toBe(0);
  });

  it('preserves a missing-page store error and unloads without storing again', async () => {
    const error = new NotFoundException('Page with id id not found');
    store.mockRejectedValueOnce(error);
    await expect(
      gateway.withYdocConnection('page.id', context, change),
    ).rejects.toBe(error);
    expect(store).toHaveBeenCalledTimes(1);
    expect(gateway.getDocumentCount()).toBe(0);
  });

  it.each(['onLoadDocument', 'afterLoadDocument'] as const)(
    'cleans up a real %s failure before a direct connection is returned',
    async (hook) => {
      server.configuration.extensions.push({
        [hook]: async () => {
          throw new Error('load failed');
        },
      });
      const edit = jest.fn(change);
      await expect(
        gateway.withYdocConnection('page.id', context, edit),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(edit).not.toHaveBeenCalled();
      expect(store).not.toHaveBeenCalled();
      expect(gateway.getDocumentCount()).toBe(0);
    },
  );

  it('preserves HTTP errors while opening and cleans up the document', async () => {
    const error = new NotFoundException('missing page');
    server.configuration.extensions.push({
      afterLoadDocument: async () => {
        throw error;
      },
    });
    await expect(
      gateway.withYdocConnection('page.id', context, change),
    ).rejects.toBe(error);
    expect(gateway.getDocumentCount()).toBe(0);
  });

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
    ).rejects.toBeInstanceOf(BadRequestException);
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
