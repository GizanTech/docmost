jest.mock('../../common/helpers/prosemirror/html', () => ({}));
jest.mock('@docmost/db/repos/page/page.repo', () => ({ PageRepo: class {} }), {
  virtual: true,
});
jest.mock(
  '@docmost/db/utils',
  () => ({
    executeTx: async (_db: unknown, fn: (trx: unknown) => unknown) => fn({}),
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
  beforeEach(() => {
    repo = { findById: jest.fn(), updatePage: jest.fn() };
    events = { emit: jest.fn() };
    queue = { add: jest.fn() };
    extension = new PersistenceExtension(repo, {} as any, events, queue, queue);
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
    expect(repo.updatePage).toHaveBeenCalledWith(
      { ydoc: expect.any(Buffer) },
      'id',
      {},
    );
    const restored = new Y.Doc();
    Y.applyUpdate(restored, repo.updatePage.mock.calls[0][0].ydoc);
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
      }),
      'id',
      {},
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
    logger.mockRestore();
    document.destroy();
  });
});
