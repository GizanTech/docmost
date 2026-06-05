import { Module } from '@nestjs/common';
import { GizantechApiController } from './gizantech-api.controller';
import { GizantechApiService } from './gizantech-api.service';
import { ExportModule } from '../export/export.module';
import { PageModule } from '../../core/page/page.module';

@Module({
  imports: [ExportModule, PageModule],
  controllers: [GizantechApiController],
  providers: [GizantechApiService],
})
export class GizantechApiModule {}
