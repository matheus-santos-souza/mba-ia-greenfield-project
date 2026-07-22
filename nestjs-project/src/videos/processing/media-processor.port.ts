import type { Readable } from 'node:stream';
import type { VideoMetadata } from '../entities/video.entity';

export interface ProcessedMediaArtifact {
  path: string;
  contentLength: number;
  contentType: string;
}

export interface ProcessedMedia {
  durationSeconds: string;
  metadata: VideoMetadata;
  playback: ProcessedMediaArtifact;
  thumbnail: ProcessedMediaArtifact;
}

export abstract class MediaProcessorPort {
  abstract withProcessedMedia<T>(
    source: Readable,
    consume: (media: ProcessedMedia) => Promise<T>,
  ): Promise<T>;

  abstract terminateActiveProcesses(): void;
}
