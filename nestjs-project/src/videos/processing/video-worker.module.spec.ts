import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import type { Worker } from 'bullmq';
import videoConfig from '../../config/video.config';
import { VideosController } from '../videos.controller';
import { FfmpegMediaProcessor } from './ffmpeg-media-processor';
import { VideoProcessingService } from './video-processing.service';
import { VideoProcessor } from './video-processor';
import { VideoWorkerModule } from './video-worker.module';
import { VideoWorkerShutdownService } from './video-worker-shutdown.service';

describe('VideoWorkerModule', () => {
  it('compiles a standalone processing context without HTTP controllers', async () => {
    const module = await Test.createTestingModule({
      imports: [VideoWorkerModule],
    }).compile();
    await module.init();

    expect(module.get(VideoProcessingService)).toBeInstanceOf(
      VideoProcessingService,
    );
    expect(module.get(VideoProcessor)).toBeInstanceOf(VideoProcessor);
    expect(
      Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, VideoWorkerModule),
    ).toBeUndefined();
    expect(() => module.get(VideosController, { strict: false })).toThrow();

    await module.close();
  }, 30_000);

  it('forces FFmpeg and the worker closed after the configured grace period', async () => {
    const close = jest.fn((force?: boolean) =>
      force ? Promise.resolve() : new Promise<void>(() => {}),
    );
    const terminateActiveProcesses = jest.fn();
    const module = await Test.createTestingModule({
      providers: [
        VideoWorkerShutdownService,
        {
          provide: VideoProcessor,
          useValue: { worker: { close } as Pick<Worker, 'close'> },
        },
        {
          provide: FfmpegMediaProcessor,
          useValue: { terminateActiveProcesses },
        },
        {
          provide: videoConfig.KEY,
          useValue: { workerShutdownGraceSeconds: 0 },
        },
      ],
    }).compile();
    const shutdown = module.get(VideoWorkerShutdownService);

    await shutdown.beforeApplicationShutdown();

    expect(close).toHaveBeenNthCalledWith(1);
    expect(terminateActiveProcesses).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenNthCalledWith(2, true);
    await module.close();
  });
});
