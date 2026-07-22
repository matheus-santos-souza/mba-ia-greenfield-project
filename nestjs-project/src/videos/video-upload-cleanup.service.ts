import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import videoConfig from '../config/video.config';
import type { ObjectStoragePort } from '../storage/object-storage.port';
import { OBJECT_STORAGE_PORT } from '../storage/storage.constants';
import { MultipartUploadNotFoundError } from '../storage/storage.errors';
import type { ExpiredVideoUpload } from './video-upload.repository';
import { VideoUploadRepository } from './video-upload.repository';

const MAX_CLEANUP_BACKOFF_MS = 15 * 60 * 1_000;

export interface VideoUploadCleanupResult {
  claimed: number;
  aborted: number;
  failed: number;
}

@Injectable()
export class VideoUploadCleanupService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(VideoUploadCleanupService.name);
  private loopPromise: Promise<void> | null = null;
  private stopping = false;
  private wakeWait: (() => void) | null = null;

  constructor(
    private readonly uploads: VideoUploadRepository,
    @Inject(OBJECT_STORAGE_PORT)
    private readonly storage: ObjectStoragePort,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  onApplicationBootstrap(): void {
    if (this.loopPromise !== null) {
      return;
    }

    this.stopping = false;
    this.loopPromise = this.runLoop();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.wakeWait?.();
    await this.loopPromise;
    this.loopPromise = null;
  }

  async cleanupOnce(now = new Date()): Promise<VideoUploadCleanupResult> {
    let failed = 0;
    const result = await this.uploads.processExpiredBatch(
      now,
      this.config.uploadCleanupBatchSize,
      async (upload) => {
        try {
          await this.storage.abortMultipartUpload({
            objectKey: upload.objectKey,
            uploadId: upload.uploadId,
          });
          return true;
        } catch (error) {
          if (error instanceof MultipartUploadNotFoundError) {
            this.logger.warn(
              `Expired multipart upload already absent videoId=${upload.videoId} uploadId=${upload.uploadId}`,
            );
            return true;
          }

          failed += 1;
          this.logUploadFailure(upload, error);
          return false;
        }
      },
    );

    return { ...result, failed };
  }

  private async runLoop(): Promise<void> {
    let consecutiveFailures = 0;

    while (!this.stopping) {
      let iterationFailed = false;
      try {
        const result = await this.cleanupOnce();
        iterationFailed = result.failed > 0;
      } catch (error) {
        iterationFailed = true;
        this.logger.error(
          `Expired upload cleanup iteration failed category=${this.errorCategory(error)}`,
        );
      }

      consecutiveFailures = iterationFailed ? consecutiveFailures + 1 : 0;
      if (!this.stopping) {
        await this.waitForNextRun(
          iterationFailed
            ? this.backoffDelay(consecutiveFailures)
            : this.config.uploadCleanupIntervalMs,
        );
      }
    }
  }

  private backoffDelay(consecutiveFailures: number): number {
    const exponent = Math.min(Math.max(consecutiveFailures - 1, 0), 20);
    return Math.min(
      this.config.uploadCleanupIntervalMs * 2 ** exponent,
      MAX_CLEANUP_BACKOFF_MS,
    );
  }

  private logUploadFailure(upload: ExpiredVideoUpload, error: unknown): void {
    this.logger.error(
      `Failed to abort expired multipart upload videoId=${upload.videoId} uploadId=${upload.uploadId} category=${this.errorCategory(error)}`,
    );
  }

  private errorCategory(error: unknown): string {
    return error instanceof Error ? error.name : 'UnknownError';
  }

  private async waitForNextRun(delayMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, delayMs);
      this.wakeWait = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
    this.wakeWait = null;
  }
}
