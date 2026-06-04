import { Module } from '@nestjs/common';
import { GizantechApiController } from './gizantech-api.controller';
import { GizantechApiService } from './gizantech-api.service';
import { ExportModule } from '../export/export.module';

@Module({
  imports: [ExportModule],
  controllers: [GizantechApiController],
  providers: [GizantechApiService],
})
export class GizantechApiModule {}
