jest.mock('../../common/helpers/prosemirror/html', () => ({}));
jest.mock('@docmost/db/repos/page/page.repo', () => ({ PageRepo: class {} }), {
  virtual: true,
});
jest.mock('../../collaboration/collaboration.gateway', () => ({
  CollaborationGateway: class {},
}));
jest.mock('../export/export.service', () => ({ ExportService: class {} }));
jest.mock('../../core/page/services/page.service', () => ({
  PageService: class {},
}));
jest.mock('../../core/space/services/space.service', () => ({
  SpaceService: class {},
}));
jest.mock('../../common/helpers', () => ({ generateSlugId: () => 'new-slug' }));

import * as Y from 'yjs';
import { ServiceUnavailableException } from '@nestjs/common';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { GizantechApiService } from './gizantech-api.service';
import { tiptapExtensions } from '../../collaboration/collaboration.util';

const content = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'new body' }] },
  ],
};

describe('GizantechApiService collaborative upsert', () => {
  const page = {
    id: 'page-id',
    slugId: 'page-slug',
    spaceId: 'space-id',
    parentPageId: null,
  };
  const user = { id: 'author', workspaceId: 'workspace-id' };
  let service: GizantechApiService;
  let db: any;
  let authorAvailable: boolean;
  let repo: any;
  let gateway: any;
  let document: Y.Doc;

  beforeEach(() => {
    authorAvailable = true;
    db = {
      selectFrom: jest.fn((table) => {
        const query: any = {};
        for (const method of [
          'select',
          'selectAll',
          'where',
          'orderBy',
          'limit',
        ])
          query[method] = jest.fn(() => query);
        query.executeTakeFirst = jest.fn(async () =>
          table === 'spaces'
            ? { id: 'space-id', slug: 'space', workspaceId: 'workspace-id' }
            : authorAvailable
              ? { id: user.id }
              : undefined,
        );
        return query;
      }),
    };
    repo = {
      findById: jest.fn(async () => page),
      updatePage: jest.fn(),
      insertPage: jest.fn(async () => ({ id: 'new-id', slugId: 'new-slug' })),
    };
    document = TiptapTransformer.toYdoc(
      {
        ...content,
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'old body' }] },
        ],
      },
      'default',
      tiptapExtensions,
    );
    gateway = {
      withYdocConnection: jest.fn(async (_name, _context, fn) => fn(document)),
    };
    service = new GizantechApiService(
      db as any,
      repo,
      { getAppUrl: () => 'https://example.test' } as any,
      {} as any,
      {} as any,
      {} as any,
      gateway,
    );
    jest
      .spyOn(service as any, 'markdownToProsemirror')
      .mockResolvedValue({ title: 'Title', prosemirrorJson: content });
    jest.spyOn(service as any, 'findByTitle').mockResolvedValue(page);
    jest.spyOn(service as any, 'getNewPagePosition').mockResolvedValue('a0');
  });
  afterEach(() => document.destroy());

  it.each([true, false])(
    'updates through the live document (pageId supplied: %s)',
    async (explicitId) => {
      const result = await service.upsert({
        spaceId: 'space-id',
        markdown: 'body',
        authorUserId: 'author',
        ...(explicitId ? { pageId: page.id } : {}),
      });
      expect(gateway.withYdocConnection).toHaveBeenCalledWith(
        'page.page-id',
        { user: { id: user.id } },
        expect.any(Function),
      );
      expect(repo.updatePage).toHaveBeenCalledTimes(1);
      expect(repo.updatePage).toHaveBeenCalledWith(
        { title: 'Title', lastUpdatedById: 'author' },
        page.id,
      );
      expect(repo.insertPage).not.toHaveBeenCalled();
      expect(
        TiptapTransformer.fromYdoc(document, 'default').content[0].content[0]
          .text,
      ).toBe('new body');
      expect(result).toEqual({
        ...page,
        title: 'Title',
        url: 'https://example.test/s/space/p/page-slug',
        created: false,
      });
    },
  );

  it('keeps fresh state on new-page insertion', async () => {
    (service as any).findByTitle.mockResolvedValue(undefined);
    const result = await service.upsert({
      spaceId: 'space-id',
      markdown: 'body',
      authorUserId: 'author',
    });
    expect(gateway.withYdocConnection).not.toHaveBeenCalled();
    expect(repo.updatePage).not.toHaveBeenCalled();
    expect(repo.insertPage).toHaveBeenCalledWith(
      expect.objectContaining({
        content,
        textContent: 'new body',
        ydoc: expect.any(Buffer),
        creatorId: 'author',
        title: 'Title',
      }),
    );
    const inserted = new Y.Doc();
    Y.applyUpdate(inserted, repo.insertPage.mock.calls[0][0].ydoc);
    expect(
      TiptapTransformer.fromYdoc(inserted, 'default').content[0].content[0]
        .text,
    ).toBe('new body');
    expect(result.created).toBe(true);
    inserted.destroy();
  });

  it('does not update metadata when the collaborative edit fails', async () => {
    gateway.withYdocConnection.mockRejectedValue(
      new ServiceUnavailableException('store failed'),
    );
    await expect(
      service.upsert({
        spaceId: 'space-id',
        pageId: page.id,
        markdown: 'body',
        authorUserId: 'author',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(repo.updatePage).not.toHaveBeenCalled();
  });
  it('selects only the author id and excludes deactivated users', async () => {
    await service.upsert({
      spaceId: 'space-id',
      pageId: page.id,
      markdown: 'body',
      authorUserId: 'author',
    });
    const query = db.selectFrom.mock.results.find(
      (_result: any, i: number) => db.selectFrom.mock.calls[i][0] === 'users',
    ).value;
    expect(
      db.selectFrom.mock.calls.filter(([table]) => table === 'users'),
    ).toHaveLength(1);
    expect(query.select).toHaveBeenCalledWith('id');
    expect(query.selectAll).not.toHaveBeenCalled();
    expect(query.where).toHaveBeenCalledWith('deactivatedAt', 'is', null);
    expect(query.where).toHaveBeenCalledWith('deletedAt', 'is', null);
    expect(query.where).toHaveBeenCalledWith(
      'workspaceId',
      '=',
      'workspace-id',
    );
  });

  it.each(['explicit', 'environment', 'fallback'])(
    'validates the %s author once before a new-page insertion',
    async (source) => {
      const previous = process.env.GIZANTECH_API_USER_ID;
      if (source === 'environment')
        process.env.GIZANTECH_API_USER_ID = 'env-author';
      else delete process.env.GIZANTECH_API_USER_ID;
      (service as any).findByTitle.mockResolvedValue(undefined);
      try {
        await service.upsert({
          spaceId: 'space-id',
          markdown: 'body',
          ...(source === 'explicit' ? { authorUserId: 'author' } : {}),
        });
        const userQueries = db.selectFrom.mock.results.filter(
          (_result, i) => db.selectFrom.mock.calls[i][0] === 'users',
        );
        expect(userQueries).toHaveLength(1);
        const query = userQueries[0].value;
        expect(query.where).toHaveBeenCalledWith(
          'workspaceId',
          '=',
          'workspace-id',
        );
        expect(query.where).toHaveBeenCalledWith('deletedAt', 'is', null);
        expect(query.where).toHaveBeenCalledWith('deactivatedAt', 'is', null);
        if (source === 'fallback') {
          expect(query.orderBy).toHaveBeenCalledWith('createdAt', 'asc');
          expect(query.limit).toHaveBeenCalledWith(1);
        } else {
          expect(query.where).toHaveBeenCalledWith(
            'id',
            '=',
            source === 'explicit' ? 'author' : 'env-author',
          );
        }
        expect(repo.insertPage).toHaveBeenCalledTimes(1);
        authorAvailable = false;
        await expect(
          service.upsert({
            spaceId: 'space-id',
            markdown: 'body',
            ...(source === 'explicit' ? { authorUserId: 'author' } : {}),
          }),
        ).rejects.toThrow(
          source === 'fallback' ? 'No user available' : 'Author user not found',
        );
        expect(repo.insertPage).toHaveBeenCalledTimes(1);
      } finally {
        if (previous === undefined) delete process.env.GIZANTECH_API_USER_ID;
        else process.env.GIZANTECH_API_USER_ID = previous;
      }
    },
  );

  it('rejects an unavailable author before editing content or metadata', async () => {
    authorAvailable = false;
    await expect(
      service.upsert({
        spaceId: 'space-id',
        pageId: page.id,
        markdown: 'body',
        authorUserId: 'author',
      }),
    ).rejects.toThrow('Author user not found');
    expect(gateway.withYdocConnection).not.toHaveBeenCalled();
    expect(repo.updatePage).not.toHaveBeenCalled();
  });
});
