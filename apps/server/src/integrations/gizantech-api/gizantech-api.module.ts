import { Module } from '@nestjs/common';
import { GizantechApiController } from './gizantech-api.controller';
import { GizantechApiService } from './gizantech-api.service';
import { ExportModule } from '../export/export.module';
import { PageModule } from '../../core/page/page.module';
import { SpaceModule } from '../../core/space/space.module';

@Module({
  imports: [ExportModule, PageModule, SpaceModule],
  controllers: [GizantechApiController],
  providers: [GizantechApiService],
})
export class GizantechApiModule {}
