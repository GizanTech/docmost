import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

export class UpsertPageDto {
  @IsString()
  @IsNotEmpty()
  spaceId: string;

  @IsString()
  markdown: string;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  parentPageId?: string;

  // When provided, update this exact page in place (stable id/slugId/url).
  @IsOptional()
  @IsString()
  pageId?: string;

  // Optional creator/updater. Falls back to GIZANTECH_API_USER_ID or first
  // workspace user.
  @IsOptional()
  @IsString()
  authorUserId?: string;
}

export class TreeDto {
  @IsString()
  @IsNotEmpty()
  spaceId: string;
}

export class ExportMdDto {
  @IsString()
  @IsNotEmpty()
  pageId: string;

  @IsOptional()
  @IsIn(['markdown', 'html'])
  format?: 'markdown' | 'html';
}
