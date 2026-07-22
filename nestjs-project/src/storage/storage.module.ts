import { S3Client } from '@aws-sdk/client-s3';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { S3ObjectStorageService } from './s3-object-storage.service';
import {
  OBJECT_STORAGE_PORT,
  S3_INTERNAL_CLIENT,
  S3_PUBLIC_CLIENT,
} from './storage.constants';
import { VideoStorageKeyService } from './video-storage-key.service';

const createS3Client = (
  config: ConfigType<typeof storageConfig>,
  endpoint: string,
): S3Client =>
  new S3Client({
    endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: config.forcePathStyle,
  });

@Module({
  providers: [
    {
      provide: S3_INTERNAL_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>) =>
        createS3Client(config, config.internalEndpoint),
    },
    {
      provide: S3_PUBLIC_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>) =>
        createS3Client(config, config.publicEndpoint),
    },
    S3ObjectStorageService,
    {
      provide: OBJECT_STORAGE_PORT,
      useExisting: S3ObjectStorageService,
    },
    VideoStorageKeyService,
  ],
  exports: [OBJECT_STORAGE_PORT, VideoStorageKeyService],
})
export class StorageModule {}
