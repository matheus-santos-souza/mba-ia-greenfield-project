import {
  Inject,
  Injectable,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import videoConfig from '../../config/video.config';
import { FfmpegMediaProcessor } from './ffmpeg-media-processor';
import { VideoProcessor } from './video-processor';

@Injectable()
export class VideoWorkerShutdownService implements BeforeApplicationShutdown {
  constructor(
    private readonly processor: VideoProcessor,
    private readonly mediaProcessor: FfmpegMediaProcessor,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  async beforeApplicationShutdown(): Promise<void> {
    const gracefulClose = this.processor.worker.close();
    let timeout: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      gracefulClose.then(() => false),
      new Promise<true>((resolve) => {
        timeout = setTimeout(
          () => resolve(true),
          this.config.workerShutdownGraceSeconds * 1_000,
        );
      }),
    ]);

    if (timeout) {
      clearTimeout(timeout);
    }
    if (!timedOut) {
      return;
    }

    this.mediaProcessor.terminateActiveProcesses();
    await this.processor.worker.close(true);
  }
}
