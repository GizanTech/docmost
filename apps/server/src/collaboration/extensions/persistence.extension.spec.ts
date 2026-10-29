jest.mock('../../common/helpers/prosemirror/html', () => ({}));
jest.mock('@docmost/db/repos/page/page.repo', () => ({ PageRepo: class {} }), {
  virtual: true,
});
jest.mock(
  '@docmost/db/utils',
  () => ({
    executeTx: async (db: any, fn: (trx: unknown) => unknown) => {
      await fn(db.trx);
      if (db.commitError) throw db.commitError;
    },
  }),
  { virtual: true },
);
jest.mock('../../common/helpers/prosemirror/utils', () => ({
  extractMentions: () => [],
  extractPageMentions: () => [],
}));

import * as Y from 'yjs';
import { Document } from '@hocuspocus/server';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { PersistenceExtension } from './persistence.extension';
import { replaceYdocContent, tiptapExtensions } from '../collaboration.util';

const content = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }],
};

describe('PersistenceExtension API edits', () => {
  let extension: PersistenceExtension;
  let repo: any;
  let events: any;
  let queue: any;
  let db: any;
  let trx: any;
  beforeEach(() => {
    repo = { findById: jest.fn(), updatePage: jest.fn() };
    events = { emit: jest.fn() };
    queue = { add: jest.fn() };
    trx = {};
    for (const method of ['updateTable', 'set', 'where']) {
      trx[method] = jest.fn(() => trx);
    }
    trx.executeTakeFirst = jest.fn();
    db = { trx };
    extension = new PersistenceExtension(repo, db, events, queue, queue);
  });

  it('loads null ydoc from JSON and persists replacement state even when JSON is unchanged', async () => {
    const empty = new Document('page.id');
    repo.findById.mockResolvedValue({ id: 'id', content, ydoc: null });
    const document = await extension.onLoadDocument({
      documentName: 'page.id',
      document: empty,
    } as any);
    const browser = new Y.Doc();
    Y.applyUpdate(browser, Y.encodeStateAsUpdate(document));
    replaceYdocContent(document, content);
    // Compare normalized JSON, as persistence does for a previously saved page.
    repo.findById.mockResolvedValue({
      id: 'id',
      content: TiptapTransformer.fromYdoc(document, 'default'),
      ydoc: null,
    });
    await extension.onStoreDocument({
      documentName: 'page.id',
      document,
      context: { user: { id: 'author' } },
      socketId: 'server',
    } as any);
    expect(repo.updatePage).not.toHaveBeenCalled();
    expect(trx.updateTable).toHaveBeenCalledWith('pages');
    expect(trx.set).toHaveBeenCalledWith({ ydoc: expect.any(Buffer) });
    expect(trx.where).toHaveBeenCalledWith('id', '=', 'id');
    expect(extension.isDirectEditPersisted(document)).toBe(true);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, trx.set.mock.calls[0][0].ydoc);
    Y.applyUpdate(
      restored,
      Y.encodeStateAsUpdate(browser, Y.encodeStateVector(restored)),
    );
    expect(
      TiptapTransformer.fromYdoc(restored, 'default').content,
    ).toHaveLength(1);
    expect(events.emit).not.toHaveBeenCalled();
    [empty, document, browser, restored].forEach((doc) => doc.destroy());
  });

  it('persists content, text and state with the direct-connection author', async () => {
    const document = TiptapTransformer.toYdoc(
      content,
      'default',
      tiptapExtensions,
    );
    repo.findById.mockResolvedValue({
      id: 'id',
      content: null,
      creatorId: 'creator',
    });
    await expect(
      extension.onChange({ documentName: 'page.id', context: {} } as any),
    ).resolves.toBeUndefined();
    await extension.onStoreDocument({
      documentName: 'page.id',
      document,
      context: { user: { id: 'author' } },
      socketId: 'server',
    } as any);
    expect(repo.updatePage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: TiptapTransformer.fromYdoc(document, 'default'),
        textContent: 'body',
        ydoc: expect.any(Buffer),
        lastUpdatedById: 'author',
        contributorIds: ['author', 'creator'],
      }),
      'id',
      trx,
    );
    document.destroy();
  });

  it('surfaces database errors to direct connections', async () => {
    const document = TiptapTransformer.toYdoc(
      content,
      'default',
      tiptapExtensions,
    );
    repo.findById.mockRejectedValue(new Error('database unavailable'));
    const logger = jest
      .spyOn((extension as any).logger, 'error')
      .mockImplementation(() => {});
    await expect(
      extension.onStoreDocument({
        documentName: 'page.id',
        document,
        context: { user: { id: 'author' } },
        socketId: 'server',
      } as any),
    ).rejects.toThrow('database unavailable');
    expect(extension.isDirectEditPersisted(document)).toBe(false);
    logger.mockRestore();
    document.destroy();
  });
  it('acknowledges an identical durable snapshot without issuing an update', async () => {
    const document = TiptapTransformer.toYdoc(
      content,
      'default',
      tiptapExtensions,
    );
    repo.findById.mockResolvedValue({
      id: 'id',
      content: TiptapTransformer.fromYdoc(document, 'default'),
      ydoc: Buffer.from(Y.encodeStateAsUpdate(document)),
    });
    await extension.onStoreDocument({
      documentName: 'page.id',
      document,
      socketId: 'server',
      context: { user: { id: 'author' } },
    } as any);
    expect(extension.isDirectEditPersisted(document)).toBe(true);
    expect(trx.updateTable).not.toHaveBeenCalled();
    expect(repo.updatePage).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
    document.destroy();
  });

  it('does not acknowledge a rolled-back transaction', async () => {
    const document = TiptapTransformer.toYdoc(
      content,
      'default',
      tiptapExtensions,
    );
    repo.findById.mockResolvedValue({ id: 'id', content: null });
    db.commitError = new Error('commit failed');
    const logger = jest
      .spyOn((extension as any).logger, 'error')
      .mockImplementation(() => {});
    await expect(
      extension.onStoreDocument({
        documentName: 'page.id',
        document,
        socketId: 'server',
        context: { user: { id: 'author' } },
      } as any),
    ).rejects.toThrow('commit failed');
    expect(extension.isDirectEditPersisted(document)).toBe(false);
    logger.mockRestore();
    document.destroy();
  });

  it('does not acknowledge a missing page', async () => {
    const document = TiptapTransformer.toYdoc(
      content,
      'default',
      tiptapExtensions,
    );
    repo.findById.mockResolvedValue(undefined);
    const logger = jest
      .spyOn((extension as any).logger, 'error')
      .mockImplementation(() => {});
    await expect(
      extension.onStoreDocument({
        documentName: 'page.id',
        document,
        socketId: 'server',
        context: { user: { id: 'author' } },
      } as any),
    ).rejects.toThrow('not found');
    expect(extension.isDirectEditPersisted(document)).toBe(false);
    logger.mockRestore();
    document.destroy();
  });

  it('detects deletion-only changes that a state-vector receipt would miss', async () => {
    const document = TiptapTransformer.toYdoc(
      content,
      'default',
      tiptapExtensions,
    );
    repo.findById.mockResolvedValue({ id: 'id', content: null });
    await extension.onStoreDocument({
      documentName: 'page.id',
      document,
      socketId: 'server',
      context: { user: { id: 'author' } },
    } as any);
    expect(extension.isDirectEditPersisted(document)).toBe(true);
    const vector = Y.encodeStateVector(document);
    document.getXmlFragment('default').delete(0, 1);
    expect(Y.encodeStateVector(document)).toEqual(vector);
    expect(extension.isDirectEditPersisted(document)).toBe(false);
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(document));
    expect(extension.isDirectEditPersisted(other)).toBe(false);
    document.destroy();
    other.destroy();
  });
});
