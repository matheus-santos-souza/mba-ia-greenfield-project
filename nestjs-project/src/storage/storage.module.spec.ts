import { MODULE_METADATA } from '@nestjs/common/constants';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import type { ObjectStoragePort } from './object-storage.port';
import { S3ObjectStorageService } from './s3-object-storage.service';
import { OBJECT_STORAGE_PORT } from './storage.constants';
import { StorageModule } from './storage.module';
import { VideoStorageKeyService } from './video-storage-key.service';

describe('StorageModule', () => {
  it('should compile with S3-compatible configuration', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    expect(module.get<ObjectStoragePort>(OBJECT_STORAGE_PORT)).toBeInstanceOf(
      S3ObjectStorageService,
    );
    expect(module.get(VideoStorageKeyService)).toBeInstanceOf(
      VideoStorageKeyService,
    );

    await module.close();
  });

  it('should export only the storage port and video key service', () => {
    const exports = Reflect.getMetadata(
      MODULE_METADATA.EXPORTS,
      StorageModule,
    ) as readonly unknown[];

    expect(exports).toEqual([OBJECT_STORAGE_PORT, VideoStorageKeyService]);
  });
});
