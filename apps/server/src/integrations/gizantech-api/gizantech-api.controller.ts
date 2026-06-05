import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from './guards/api-key.guard';
import { GizantechApiService } from './gizantech-api.service';
import {
  ExportMdDto,
  MovePageDto,
  TreeDto,
  UpsertPageDto,
} from './dto/gizantech.dto';

/**
 * GizanTech integration API. Static API-key auth (GIZANTECH_API_KEY).
 * Exposed under the global `/api` prefix at `/api/gizantech/*`.
 *
 * This surface powers the docmost MCP server and future MadeByOC embedding.
 */
@UseGuards(ApiKeyGuard)
@Controller('gizantech')
export class GizantechApiController {
  constructor(private readonly service: GizantechApiService) {}

  @HttpCode(200)
  @Post('upsert')
  async upsert(@Body() dto: UpsertPageDto) {
    return this.service.upsert(dto);
  }

  @HttpCode(200)
  @Post('tree')
  async tree(@Body() dto: TreeDto) {
    return this.service.tree(dto.spaceId);
  }

  @HttpCode(200)
  @Post('export')
  async exportPage(@Body() dto: ExportMdDto) {
    return this.service.exportMarkdown(dto.pageId, dto.format ?? 'markdown');
  }

  @HttpCode(200)
  @Post('move')
  async move(@Body() dto: MovePageDto) {
    return this.service.move(dto);
  }
}
