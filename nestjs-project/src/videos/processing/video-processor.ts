import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import type { ProcessVideoJob } from './process-video.job';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing-queue.constants';
import { VideoProcessingService } from './video-processing.service';

const configuredConcurrency = Number.parseInt(
  process.env.VIDEO_PROCESSING_CONCURRENCY ?? '1',
  10,
);

@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: configuredConcurrency })
export class VideoProcessor extends WorkerHost {
  constructor(private readonly processing: VideoProcessingService) {
    super();
  }

  async process(
    job: Job<ProcessVideoJob, void, typeof PROCESS_VIDEO_JOB>,
  ): Promise<void> {
    if (job.name !== PROCESS_VIDEO_JOB) {
      throw new Error('Unsupported video processing job');
    }

    const attempts = job.opts.attempts ?? 1;
    const finalAttempt = job.attemptsMade + 1 >= attempts;
    await this.processing.process(job.data.videoId, finalAttempt);
  }
}
