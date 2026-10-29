// HTML conversion is not used by these Y.js tests; its .js imports need a build.
jest.mock('../common/helpers/prosemirror/html', () => ({}));

import * as Y from 'yjs';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { Hocuspocus } from '@hocuspocus/server';
import { replaceYdocContent, tiptapExtensions } from './collaboration.util';

const body = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const create = (text: string) =>
  TiptapTransformer.toYdoc(body(text), 'default', tiptapExtensions);
const paragraphs = (doc: Y.Doc) =>
  TiptapTransformer.fromYdoc(doc, 'default').content.map((p: any) =>
    (p.content ?? []).map((t: any) => t.text ?? '').join(''),
  );
const copy = (doc: Y.Doc) => {
  const browser = new Y.Doc();
  Y.applyUpdate(browser, Y.encodeStateAsUpdate(doc));
  return browser;
};
const sync = (server: Y.Doc, browser: Y.Doc) => {
  const toServer = Y.encodeStateAsUpdate(browser, Y.encodeStateVector(server));
  const toBrowser = Y.encodeStateAsUpdate(server, Y.encodeStateVector(browser));
  Y.applyUpdate(server, toServer);
  Y.applyUpdate(browser, toBrowser);
};

describe('API replacement with a stale browser copy', () => {
  it('reproduces doubling when the stored document is replaced', () => {
    const old = create('old body');
    const browser = copy(old);
    const server = create('new body');
    sync(server, browser);
    expect(paragraphs(server).sort()).toEqual(['new body', 'old body']);
    expect(paragraphs(browser).sort()).toEqual(['new body', 'old body']);
    [old, browser, server].forEach((doc) => doc.destroy());
  });

  it.each(['old body', 'new body'])(
    'retains deletions when replacing %s',
    (oldText) => {
      const server = create(oldText);
      const browser = copy(server);
      replaceYdocContent(server, body('new body'));
      // Include a DB save/reload before the stale browser reconnects.
      const reloaded = copy(server);
      sync(reloaded, browser);
      expect(paragraphs(reloaded)).toEqual(['new body']);
      expect(paragraphs(browser)).toEqual(['new body']);
      [server, browser, reloaded].forEach((doc) => doc.destroy());
    },
  );

  it('stores promptly and updates an already loaded document without authentication', async () => {
    const old = create('old body');
    const browser = copy(old);
    const onAuthenticate = jest.fn(() => {
      throw new Error('websocket auth only');
    });
    const stores: any[] = [];
    const user = { id: 'api-author' };
    const server = new Hocuspocus({
      debounce: 10000,
      unloadImmediately: false,
      extensions: [
        {
          onAuthenticate,
          onLoadDocument: async () => old,
          onStoreDocument: async ({ document, context }) => {
            stores.push({ body: paragraphs(document), context });
          },
        },
      ],
    });
    const openBrowser = await server.openDirectConnection('page.example', {
      user,
    });
    const edit = await server.openDirectConnection('page.example', { user });
    try {
      expect(edit.document).toBe(openBrowser.document);
      await edit.transact((doc) => replaceYdocContent(doc, body('new body')));
      expect(stores).toContainEqual({ body: ['new body'], context: { user } });
      sync(openBrowser.document!, browser);
      expect(paragraphs(openBrowser.document!)).toEqual(['new body']);
      expect(paragraphs(browser)).toEqual(['new body']);
      expect(onAuthenticate).not.toHaveBeenCalled();
      await edit.disconnect();
      expect(stores.length).toBeGreaterThanOrEqual(2);
    } finally {
      await edit.disconnect();
      await openBrowser.disconnect();
      await server.destroy();
      old.destroy();
      browser.destroy();
    }
  });
});
