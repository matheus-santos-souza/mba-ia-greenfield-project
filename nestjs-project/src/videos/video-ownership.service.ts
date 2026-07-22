import { Injectable } from '@nestjs/common';
import { Channel } from '../channels/entities/channel.entity';
import { Video } from './entities/video.entity';
import {
  VideoAccessDeniedException,
  VideoNotFoundException,
  UploadSessionNotFoundException,
} from './video.exceptions';
import { VideoRepository, type VideoWithUpload } from './video.repository';

@Injectable()
export class VideoOwnershipService {
  constructor(private readonly videos: VideoRepository) {}

  async requireChannel(userId: string): Promise<Channel> {
    const channel = await this.videos.findChannelByUserId(userId);
    if (!channel) {
      throw new VideoAccessDeniedException();
    }
    return channel;
  }

  async requireVideo(userId: string, identifier: string): Promise<Video> {
    const video = await this.videos.findByIdOrPublicId(identifier);
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.channel.user_id !== userId) {
      throw new VideoAccessDeniedException();
    }
    return video;
  }

  async requireUpload(
    userId: string,
    videoId: string,
    uploadId: string,
  ): Promise<VideoWithUpload> {
    const session = await this.videos.findUploadSession(videoId, uploadId);
    if (!session) {
      throw new UploadSessionNotFoundException();
    }
    if (session.video.channel.user_id !== userId) {
      throw new VideoAccessDeniedException();
    }
    return session;
  }
}
