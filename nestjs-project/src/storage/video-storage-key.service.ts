import { Injectable } from '@nestjs/common';

@Injectable()
export class VideoStorageKeyService {
  source(videoId: string): string {
    return `videos/${videoId}/source/original`;
  }

  playback(videoId: string): string {
    return `videos/${videoId}/playback/video.mp4`;
  }

  thumbnail(videoId: string): string {
    return `videos/${videoId}/thumbnails/default.jpg`;
  }
}
