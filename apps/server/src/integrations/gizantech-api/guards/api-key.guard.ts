import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'crypto';

/**
 * Static API-key guard for the GizanTech integration API.
 *
 * The key is read from the GIZANTECH_API_KEY environment variable. If it is not
 * set, every request is rejected so the integration surface stays disabled
 * unless explicitly configured. The key may be supplied either as an
 * `x-api-key` header or as a `Authorization: Bearer <key>` header.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.GIZANTECH_API_KEY;
    if (!expected) {
      throw new UnauthorizedException('GizanTech API is not configured');
    }

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const headerKey = req.headers['x-api-key'];
    const authHeader = req.headers['authorization'];

    let provided: string | undefined;
    if (typeof headerKey === 'string') {
      provided = headerKey;
    } else if (typeof authHeader === 'string') {
      provided = authHeader.replace(/^Bearer\s+/i, '');
    }

    if (!provided || !this.safeEqual(provided, expected)) {
      throw new UnauthorizedException('Invalid API key');
    }
    return true;
  }

  private safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) {
      return false;
    }
    return timingSafeEqual(ab, bb);
  }
}
