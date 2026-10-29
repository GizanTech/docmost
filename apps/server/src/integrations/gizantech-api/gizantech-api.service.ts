import { CollaborationGateway } from '../../collaboration/collaboration.gateway';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { markdownToHtml } from '@docmost/editor-ext';
import { TiptapTransformer } from '@hocuspocus/transformer';
import * as Y from 'yjs';
import { generateJitteredKeyBetween } from 'fractional-indexing-jittered';
import {
  htmlToJson,
  jsonToText,
  replaceYdocContent,
  tiptapExtensions,
} from '../../collaboration/collaboration.util';
import { generateSlugId } from '../../common/helpers';
import { EnvironmentService } from '../environment/environment.service';
import { ExportService } from '../export/export.service';
import { ExportFormat } from '../export/dto/export-dto';
import { PageService } from '../../core/page/services/page.service';
import { SpaceService } from '../../core/space/services/space.service';
import { User } from '@docmost/db/types/entity.types';
import {
  CreateSpaceGizDto,
  MovePageDto,
  UpsertPageDto,
} from './dto/gizantech.dto';

export interface UpsertResult {
  id: string;
  slugId: string;
  title: string;
  spaceId: string;
  parentPageId: string | null;
  url: string;
  created: boolean;
}

export interface TreeNode {
  id: string;
  slugId: string;
  title: string;
  icon: string | null;
  position: string;
  parentPageId: string | null;
  children: TreeNode[];
}

export interface SpaceResult {
  id: string;
  name: string;
  slug: string | null;
  url: string;
  created: boolean;
}

@Injectable()
export class GizantechApiService {
  private readonly logger = new Logger(GizantechApiService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pageRepo: PageRepo,
    private readonly environmentService: EnvironmentService,
    private readonly exportService: ExportService,
    private readonly pageService: PageService,
    private readonly spaceService: SpaceService,
    private readonly collaborationGateway: CollaborationGateway,
  ) {}

  /**
   * Create a page or update one in place from markdown, preserving the page id,
   * slugId and URL across updates. Idempotent: when no pageId is given, an
   * existing non-deleted page with the same (spaceId, parentPageId, title) is
   * updated rather than duplicated.
   */
  async upsert(dto: UpsertPageDto): Promise<UpsertResult> {
    const space = await this.db
      .selectFrom('spaces')
      .select(['id', 'slug', 'workspaceId'])
      .where('id', '=', dto.spaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();

    if (!space) {
      throw new NotFoundException('Space not found');
    }

    const { title: extractedTitle, prosemirrorJson } =
      await this.markdownToProsemirror(dto.markdown);

    const title = dto.title ?? extractedTitle ?? 'Untitled';
    const authorId = await this.resolveAuthor(
      space.workspaceId,
      dto.authorUserId,
    );

    // Explicit in-place update by pageId.
    if (dto.pageId) {
      const existing = await this.pageRepo.findById(dto.pageId);
      if (!existing || existing.spaceId !== dto.spaceId) {
        throw new NotFoundException('Page not found in the given space');
      }
      await this.updateExistingPage(
        existing.id,
        title,
        prosemirrorJson,
        authorId,
        space.workspaceId,
      );
      return this.buildResult(
        existing.id,
        existing.slugId,
        title,
        space,
        existing.parentPageId,
        false,
      );
    }

    // Idempotent upsert by (space, parent, title).
    const match = await this.findByTitle(
      dto.spaceId,
      dto.parentPageId ?? null,
      title,
    );
    if (match) {
      await this.updateExistingPage(
        match.id,
        title,
        prosemirrorJson,
        authorId,
        space.workspaceId,
      );
      return this.buildResult(
        match.id,
        match.slugId,
        title,
        space,
        dto.parentPageId ?? null,
        false,
      );
    }

    const content = prosemirrorJson;
    const textContent = jsonToText(prosemirrorJson);
    const ydoc = await this.createYdoc(prosemirrorJson);
    const slugId = generateSlugId();
    const position = await this.getNewPagePosition(
      dto.spaceId,
      dto.parentPageId ?? null,
    );
    const created = await this.pageRepo.insertPage({
      slugId,
      title,
      content,
      textContent,
      ydoc,
      position,
      spaceId: dto.spaceId,
      parentPageId: dto.parentPageId ?? null,
      creatorId: authorId,
      lastUpdatedById: authorId,
      workspaceId: space.workspaceId,
    });

    return this.buildResult(
      created.id,
      created.slugId,
      title,
      space,
      dto.parentPageId ?? null,
      true,
    );
  }

  async tree(spaceId: string): Promise<TreeNode[]> {
    const space = await this.db
      .selectFrom('spaces')
      .select(['id'])
      .where('id', '=', spaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (!space) {
      throw new NotFoundException('Space not found');
    }

    const rows = await this.db
      .selectFrom('pages')
      .select(['id', 'slugId', 'title', 'icon', 'position', 'parentPageId'])
      .where('spaceId', '=', spaceId)
      .where('deletedAt', 'is', null)
      .orderBy('position', (ob) => ob.collate('C').asc())
      .execute();

    const byParent = new Map<string | null, TreeNode[]>();
    for (const r of rows) {
      const node: TreeNode = {
        id: r.id,
        slugId: r.slugId,
        title: r.title,
        icon: r.icon,
        position: r.position,
        parentPageId: r.parentPageId,
        children: [],
      };
      const key = r.parentPageId ?? null;
      const list = byParent.get(key) ?? [];
      list.push(node);
      byParent.set(key, list);
    }

    const attach = (node: TreeNode) => {
      node.children = byParent.get(node.id) ?? [];
      node.children.forEach(attach);
    };
    const roots = byParent.get(null) ?? [];
    roots.forEach(attach);
    return roots;
  }

  async exportMarkdown(
    pageId: string,
    format: 'markdown' | 'html' = 'markdown',
  ): Promise<{ pageId: string; format: string; content: string }> {
    const page = await this.pageRepo.findById(pageId, { includeContent: true });
    if (!page) {
      throw new NotFoundException('Page not found');
    }
    const fmt =
      format === 'html' ? ExportFormat.HTML : ExportFormat.Markdown;
    const content = await this.exportService.exportPage(fmt, page, true);
    return { pageId: page.id, format, content };
  }

  // --- helpers -------------------------------------------------------------

  private async updateExistingPage(
    pageId: string,
    title: string,
    content: any,
    authorId: string,
    workspaceId: string,
  ): Promise<void> {
    const user = await this.db
      .selectFrom('users')
      .select('id')
      .where('id', '=', authorId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .where('deactivatedAt', 'is', null)
      .executeTakeFirst();
    if (!user) {
      throw new BadRequestException('Author user not found');
    }
    await this.collaborationGateway.withYdocConnection(
      `page.${pageId}`,
      { user },
      (document) => replaceYdocContent(document, content),
    );
    await this.pageRepo.updatePage({ title, lastUpdatedById: authorId }, pageId);
  }

  private async markdownToProsemirror(
    markdown: string,
  ): Promise<{ title: string | null; prosemirrorJson: any }> {
    let html: string;
    try {
      html = await markdownToHtml(markdown);
    } catch (err) {
      this.logger.error('Failed to convert markdown', err as Error);
      throw new BadRequestException('Invalid markdown');
    }
    const prosemirrorState = htmlToJson(html);
    return this.extractTitleAndRemoveHeading(prosemirrorState);
  }

  private extractTitleAndRemoveHeading(prosemirrorState: any) {
    let title: string | null = null;
    const content = prosemirrorState.content ?? [];
    if (
      content.length > 0 &&
      content[0].type === 'heading' &&
      content[0].attrs?.level === 1
    ) {
      title = content[0].content?.[0]?.text ?? null;
      content.shift();
    }
    if (content.length === 0) {
      content.push({ type: 'paragraph', content: [] });
    }
    return { title, prosemirrorJson: { ...prosemirrorState, content } };
  }

  private async createYdoc(prosemirrorJson: any): Promise<Buffer | null> {
    if (!prosemirrorJson) {
      return null;
    }
    const ydoc = TiptapTransformer.toYdoc(
      prosemirrorJson,
      'default',
      tiptapExtensions,
    );
    return Buffer.from(Y.encodeStateAsUpdate(ydoc));
  }

  /**
   * Move a page within or across spaces. When `spaceId` is given and differs
   * from the page's current space, the page and all its descendants are moved
   * into that space first (cascading). When `parentPageId` is provided, the
   * page is re-parented within the target space (pass null for the space root);
   * a fresh end-of-list position is computed server-side. Returns the canonical
   * result with the (possibly unchanged) authenticated URL.
   */
  async move(dto: MovePageDto): Promise<UpsertResult> {
    let page = await this.pageRepo.findById(dto.pageId);
    if (!page) {
      throw new NotFoundException('Page not found');
    }

    // 1) Change space first (cascades to descendants), if requested.
    if (dto.spaceId && dto.spaceId !== page.spaceId) {
      const targetSpace = await this.db
        .selectFrom('spaces')
        .select(['id'])
        .where('id', '=', dto.spaceId)
        .where('deletedAt', 'is', null)
        .executeTakeFirst();
      if (!targetSpace) {
        throw new NotFoundException('Target space not found');
      }
      await this.pageService.movePageToSpace(page, dto.spaceId);
      page = await this.pageRepo.findById(dto.pageId);
    }

    // 2) Re-parent / reorder within the current space, if requested.
    if (dto.parentPageId !== undefined) {
      const parentPageId = dto.parentPageId ?? null;
      if (parentPageId) {
        const parent = await this.pageRepo.findById(parentPageId);
        if (!parent || parent.spaceId !== page.spaceId) {
          throw new NotFoundException('Parent page not found in target space');
        }
      }
      const position = await this.getNewPagePosition(
        page.spaceId,
        parentPageId,
      );
      await this.pageService.movePage(
        { pageId: page.id, parentPageId, position },
        page,
      );
      page = await this.pageRepo.findById(dto.pageId);
    }

    const space = await this.db
      .selectFrom('spaces')
      .select(['id', 'slug'])
      .where('id', '=', page.spaceId)
      .executeTakeFirst();

    return this.buildResult(
      page.id,
      page.slugId,
      page.title,
      space,
      page.parentPageId,
      false,
    );
  }

  private async findByTitle(
    spaceId: string,
    parentPageId: string | null,
    title: string,
  ) {
    let q = this.db
      .selectFrom('pages')
      .select(['id', 'slugId'])
      .where('spaceId', '=', spaceId)
      .where('title', '=', title)
      .where('deletedAt', 'is', null);
    q =
      parentPageId === null
        ? q.where('parentPageId', 'is', null)
        : q.where('parentPageId', '=', parentPageId);
    return q.executeTakeFirst();
  }

  private async getNewPagePosition(
    spaceId: string,
    parentPageId: string | null,
  ): Promise<string> {
    let q = this.db
      .selectFrom('pages')
      .select(['id', 'position'])
      .where('spaceId', '=', spaceId)
      .orderBy('position', (ob) => ob.collate('C').desc())
      .limit(50);
    q =
      parentPageId === null
        ? q.where('parentPageId', 'is', null)
        : q.where('parentPageId', '=', parentPageId);
    const rows = await q.execute();
    return this.safeAppendKey(
      rows.map((r) => r.position).filter((p): p is string => !!p),
    );
  }

  /**
   * Build a fractional-index key that sorts after the highest existing sibling.
   * Docmost's frontend reorders pages with the non-jittered `fractional-indexing`
   * library, which can persist keys (e.g. "z0"/"z1") that the server-side
   * `fractional-indexing-jittered` validator rejects with "invalid firstChar on
   * key". We therefore walk the top positions (highest first) and append after
   * the first one that parses; if none parse, we mint a fresh first key so the
   * insert always succeeds.
   */
  private safeAppendKey(positionsDesc: string[]): string {
    for (const pos of positionsDesc) {
      try {
        return generateJitteredKeyBetween(pos, null);
      } catch {
        // legacy/non-jittered key — try the next-lower sibling
      }
    }
    return generateJitteredKeyBetween(null, null);
  }

  /**
   * Create a new space (API-key surface). Mirrors the privileged behaviour of
   * the page upsert path: it bypasses the workspace-role ACL that gates the
   * stock POST /api/spaces/create (members get 403), so the MCP/service account
   * can provision project spaces. The resolved author becomes the space admin.
   */
  async createSpace(dto: CreateSpaceGizDto): Promise<SpaceResult> {
    const workspace = await this.db
      .selectFrom('workspaces')
      .select(['id'])
      .orderBy('createdAt', 'asc')
      .limit(1)
      .executeTakeFirst();
    if (!workspace) {
      throw new BadRequestException('No workspace available');
    }

    const authorId = await this.resolveAuthor(workspace.id, dto.authorUserId);
    const authUser = await this.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', authorId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (!authUser) {
      throw new BadRequestException('Author user not found');
    }

    const slug = await this.normalizeSpaceSlug(
      dto.slug ?? dto.name,
      workspace.id,
    );

    const space = await this.spaceService.createSpace(
      authUser as unknown as User,
      workspace.id,
      { name: dto.name, slug, description: dto.description },
    );

    const appUrl = this.environmentService.getAppUrl().replace(/\/$/, '');
    const spaceSeg = space.slug ?? space.id;
    return {
      id: space.id,
      name: space.name,
      slug: space.slug ?? null,
      url: `${appUrl}/s/${spaceSeg}/home`,
      created: true,
    };
  }

  /**
   * Produce a unique alphanumeric slug (Docmost requires letters/numbers only,
   * 2-50 chars). Strips non-alphanumerics from the base, lowercases, and
   * auto-suffixes on collision within the workspace.
   */
  private async normalizeSpaceSlug(
    base: string,
    workspaceId: string,
  ): Promise<string> {
    let slug = (base || 'space').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (slug.length < 2) {
      slug = 'space';
    }
    slug = slug.slice(0, 50);

    for (let i = 0; i < 6; i++) {
      const exists = await this.db
        .selectFrom('spaces')
        .select('id')
        .where('slug', '=', slug)
        .where('workspaceId', '=', workspaceId)
        .executeTakeFirst();
      if (!exists) {
        return slug;
      }
      const suffix = Math.random().toString(36).slice(2, 6);
      slug = (slug.slice(0, 45) + suffix).slice(0, 50);
    }
    return slug;
  }

  private async resolveAuthor(
    workspaceId: string,
    authorUserId?: string,
  ): Promise<string> {
    if (authorUserId) {
      return authorUserId;
    }
    const envUser = process.env.GIZANTECH_API_USER_ID;
    if (envUser) {
      return envUser;
    }
    const user = await this.db
      .selectFrom('users')
      .select(['id'])
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'asc')
      .limit(1)
      .executeTakeFirst();
    if (!user) {
      throw new BadRequestException('No user available to attribute the page');
    }
    return user.id;
  }

  private buildResult(
    id: string,
    slugId: string,
    title: string,
    space: { id: string; slug: string | null },
    parentPageId: string | null,
    created: boolean,
  ): UpsertResult {
    const appUrl = this.environmentService.getAppUrl().replace(/\/$/, '');
    const spaceSeg = space.slug ?? space.id;
    return {
      id,
      slugId,
      title,
      spaceId: space.id,
      parentPageId,
      url: `${appUrl}/s/${spaceSeg}/p/${slugId}`,
      created,
    };
  }
}
