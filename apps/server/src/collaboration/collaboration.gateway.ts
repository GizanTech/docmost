import { Doc } from 'yjs';
import { User } from '@docmost/db/types/entity.types';
import { Hocuspocus, Server as HocuspocusServer } from '@hocuspocus/server';
import { IncomingMessage } from 'http';
import WebSocket from 'ws';
import { AuthenticationExtension } from './extensions/authentication.extension';
import { PersistenceExtension } from './extensions/persistence.extension';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Redis } from '@hocuspocus/extension-redis';
import { EnvironmentService } from '../integrations/environment/environment.service';
import {
  createRetryStrategy,
  parseRedisUrl,
  RedisConfig,
} from '../common/helpers';
import { LoggerExtension } from './extensions/logger.extension';

@Injectable()
export class CollaborationGateway {
  private hocuspocus: Hocuspocus;
  private redisConfig: RedisConfig;

  constructor(
    private authenticationExtension: AuthenticationExtension,
    private persistenceExtension: PersistenceExtension,
    private loggerExtension: LoggerExtension,
    private environmentService: EnvironmentService,
  ) {
    this.redisConfig = parseRedisUrl(this.environmentService.getRedisUrl());

    this.hocuspocus = HocuspocusServer.configure({
      debounce: 10000,
      maxDebounce: 45000,
      unloadImmediately: false,
      extensions: [
        this.authenticationExtension,
        this.persistenceExtension,
        this.loggerExtension,
        ...(this.environmentService.isCollabDisableRedis()
          ? []
          : [
              new Redis({
                host: this.redisConfig.host,
                port: this.redisConfig.port,
                options: {
                  password: this.redisConfig.password,
                  db: this.redisConfig.db,
                  family: this.redisConfig.family,
                  retryStrategy: createRetryStrategy(),
                },
              }),
            ]),
      ],
    });
  }

  async withYdocConnection(
    documentName: string,
    context: { user: Pick<User, 'id'> },
    change: (document: Doc) => void,
  ): Promise<void> {
    // Redis afterLoadDocument does not wait for remote state. Replacements
    // require API and collaboration in the same single process; multiple app
    // replicas sharing Redis have the same unsupported limitation.
    if (this.environmentService.getCollabUrl()) {
      throw new ServiceUnavailableException(
        'API edits of existing pages require a single API/collaboration process; COLLAB_URL must not be configured',
      );
    }
    const connection = await this.hocuspocus.openDirectConnection(
      documentName,
      context,
    );
    const document = connection.document!;
    let persisted = false;
    try {
      await connection.transact(change);
      // Redis 2.15 can silently skip persistence on lock contention. Its default
      // lock timeout is 1000ms; retry stores (not the edit) across that window.
      for (let retry = 0; retry < 5; retry++) {
        if (this.persistenceExtension.isDirectEditPersisted(document)) {
          persisted = true;
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
        await connection.transact(() => {});
      }
      if (!this.persistenceExtension.isDirectEditPersisted(document)) {
        throw new ServiceUnavailableException(
          'Page persistence could not be confirmed; retry the full-body upsert',
        );
      }
      persisted = true;
    } catch (error) {
      // Full-body replacement is idempotent, so callers can retry a failed upsert.
      // Connected browsers already see the edit and their next store may save it.
      throw new ServiceUnavailableException(
        'Page persistence could not be confirmed; retry the full-body upsert',
        { cause: error },
      );
    } finally {
      // DirectConnection.disconnect() stores again, even after a failed edit.
      // Use the public 2.15 Document lifecycle methods to release without saving
      // a failed write later, and unload idle docs so destroy() can complete.
      if (persisted) {
        // Preserve Redis's afterStoreDocument sync delay on successful writes.
        // A redundant disconnect store may fail, but this edit is committed.
        try {
          await connection.disconnect();
        } catch {
          // disconnect already decremented the direct connection count.
          connection.document = null;
          if (document.getConnectionsCount() === 0) {
            await this.hocuspocus.unloadDocument(document);
          }
        }
      } else {
        document.removeDirectConnection();
        connection.document = null;
        if (document.getConnectionsCount() === 0) {
          await this.hocuspocus.unloadDocument(document);
        }
      }
    }
  }

  handleConnection(client: WebSocket, request: IncomingMessage): any {
    this.hocuspocus.handleConnection(client, request);
  }

  getConnectionCount() {
    return this.hocuspocus.getConnectionsCount();
  }

  getDocumentCount() {
    return this.hocuspocus.getDocumentsCount();
  }

  async destroy(): Promise<void> {
    await this.hocuspocus.destroy();
  }
}
