import type { PROCESS_VIDEO_JOB } from './video-processing-queue.constants';

export interface ProcessVideoJob {
  version: 1;
  eventId: string;
  videoId: string;
}

export interface ProcessVideoQueueJob {
  data: ProcessVideoJob;
  name: typeof PROCESS_VIDEO_JOB;
}
