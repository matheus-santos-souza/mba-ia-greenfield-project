import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Readable } from 'node:stream';
import storageConfig from '../config/storage.config';
import {
  MAX_MULTIPART_PARTS,
  S3_INTERNAL_CLIENT,
  S3_PUBLIC_CLIENT,
} from './storage.constants';
import {
  InvalidObjectStorageRequestError,
  MultipartUploadNotFoundError,
  ObjectStorageError,
  ObjectStorageNotFoundError,
  ObjectStorageUnavailableError,
} from './storage.errors';
import type {
  CompleteMultipartUploadInput,
  CreateMultipartUploadInput,
  GetObjectInput,
  MultipartPart,
  MultipartUpload,
  MultipartUploadReference,
  ObjectStoragePort,
  PresignedMultipartPart,
  PresignGetObjectInput,
  SignMultipartPartsInput,
  StoredObject,
  StoredObjectMetadata,
  StoredObjectReference,
  UploadObjectInput,
} from './object-storage.port';

@Injectable()
export class S3ObjectStorageService
  implements ObjectStoragePort, OnModuleDestroy
{
  constructor(
    @Inject(S3_INTERNAL_CLIENT)
    private readonly internalClient: S3Client,
    @Inject(S3_PUBLIC_CLIENT)
    private readonly publicClient: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async createMultipartUpload(
    input: CreateMultipartUploadInput,
  ): Promise<MultipartUpload> {
    return this.execute('create multipart upload', async () => {
      const result = await this.internalClient.send(
        new CreateMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: input.objectKey,
          ContentType: input.contentType,
          Metadata: input.metadata,
        }),
      );

      if (!result.UploadId) {
        throw new ObjectStorageUnavailableError(
          'create multipart upload',
          'Object storage did not return a multipart upload identifier',
        );
      }

      return { uploadId: result.UploadId, objectKey: input.objectKey };
    });
  }

  async signMultipartParts(
    input: SignMultipartPartsInput,
  ): Promise<readonly PresignedMultipartPart[]> {
    this.assertPartNumbers(input.partNumbers);

    return this.execute('sign multipart parts', async () =>
      Promise.all(
        input.partNumbers.map(async (partNumber) => ({
          partNumber,
          url: await getSignedUrl(
            this.publicClient,
            new UploadPartCommand({
              Bucket: this.config.bucket,
              Key: input.objectKey,
              UploadId: input.uploadId,
              PartNumber: partNumber,
            }),
            {
              expiresIn:
                input.expiresInSeconds ?? this.config.uploadPartUrlTtlSeconds,
            },
          ),
        })),
      ),
    );
  }

  async listMultipartParts(
    input: MultipartUploadReference,
  ): Promise<readonly MultipartPart[]> {
    return this.execute('list multipart parts', async () => {
      const parts: MultipartPart[] = [];
      let partNumberMarker: string | undefined;

      do {
        const result = await this.internalClient.send(
          new ListPartsCommand({
            Bucket: this.config.bucket,
            Key: input.objectKey,
            UploadId: input.uploadId,
            PartNumberMarker: partNumberMarker,
          }),
        );

        for (const part of result.Parts ?? []) {
          if (part.PartNumber === undefined || !part.ETag) {
            continue;
          }

          parts.push({
            partNumber: part.PartNumber,
            etag: part.ETag,
            size: part.Size,
            checksumCrc32: part.ChecksumCRC32,
            checksumCrc32C: part.ChecksumCRC32C,
            checksumSha1: part.ChecksumSHA1,
            checksumSha256: part.ChecksumSHA256,
          });
        }

        partNumberMarker = result.IsTruncated
          ? result.NextPartNumberMarker
          : undefined;
      } while (partNumberMarker);

      return parts.sort((left, right) => left.partNumber - right.partNumber);
    });
  }

  async completeMultipartUpload(
    input: CompleteMultipartUploadInput,
  ): Promise<StoredObjectReference> {
    this.assertCompletionParts(input.parts);

    return this.execute('complete multipart upload', async () => {
      const result = await this.internalClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: input.objectKey,
          UploadId: input.uploadId,
          MultipartUpload: {
            Parts: input.parts.map((part) => ({
              PartNumber: part.partNumber,
              ETag: part.etag,
              ChecksumCRC32: part.checksumCrc32,
              ChecksumCRC32C: part.checksumCrc32C,
              ChecksumSHA1: part.checksumSha1,
              ChecksumSHA256: part.checksumSha256,
            })),
          },
        }),
      );

      return { objectKey: input.objectKey, etag: result.ETag };
    });
  }

  async abortMultipartUpload(input: MultipartUploadReference): Promise<void> {
    await this.execute('abort multipart upload', async () => {
      await this.internalClient.send(
        new AbortMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: input.objectKey,
          UploadId: input.uploadId,
        }),
      );
    });
  }

  async getObject(input: GetObjectInput): Promise<StoredObject> {
    return this.execute('get object', async () => {
      const result = await this.internalClient.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: input.objectKey,
          Range: input.range,
        }),
      );

      if (!(result.Body instanceof Readable)) {
        throw new ObjectStorageUnavailableError(
          'get object',
          'Object storage returned an unsupported response body',
        );
      }

      return {
        body: result.Body,
        contentLength: result.ContentLength,
        contentType: result.ContentType,
        contentRange: result.ContentRange,
        acceptRanges: result.AcceptRanges,
        etag: result.ETag,
      };
    });
  }

  async uploadObject(input: UploadObjectInput): Promise<StoredObjectReference> {
    return this.execute('upload object', async () => {
      const result = await this.internalClient.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: input.objectKey,
          Body: input.body,
          ContentLength: input.contentLength,
          ContentType: input.contentType,
        }),
      );

      return { objectKey: input.objectKey, etag: result.ETag };
    });
  }

  async headObject(objectKey: string): Promise<StoredObjectMetadata> {
    return this.execute('head object', async () => {
      const result = await this.internalClient.send(
        new HeadObjectCommand({
          Bucket: this.config.bucket,
          Key: objectKey,
        }),
      );

      return {
        contentLength: result.ContentLength,
        contentType: result.ContentType,
        etag: result.ETag,
        lastModified: result.LastModified,
      };
    });
  }

  async presignGetObject(input: PresignGetObjectInput): Promise<string> {
    return this.execute('sign get object', async () =>
      getSignedUrl(
        this.publicClient,
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: input.objectKey,
          Range: input.range,
          ResponseContentDisposition: input.responseContentDisposition,
        }),
        {
          expiresIn:
            input.expiresInSeconds ?? this.config.playbackUrlTtlSeconds,
        },
      ),
    );
  }

  onModuleDestroy(): void {
    this.internalClient.destroy();
    this.publicClient.destroy();
  }

  private assertPartNumbers(partNumbers: readonly number[]): void {
    const uniquePartNumbers = new Set(partNumbers);
    const hasInvalidPartNumber = partNumbers.some(
      (partNumber) =>
        !Number.isInteger(partNumber) ||
        partNumber < 1 ||
        partNumber > MAX_MULTIPART_PARTS,
    );

    if (
      partNumbers.length === 0 ||
      partNumbers.length > MAX_MULTIPART_PARTS ||
      uniquePartNumbers.size !== partNumbers.length ||
      hasInvalidPartNumber
    ) {
      throw new InvalidObjectStorageRequestError(
        'sign multipart parts',
        `Part numbers must be unique integers between 1 and ${MAX_MULTIPART_PARTS}`,
      );
    }
  }

  private assertCompletionParts(parts: readonly MultipartPart[]): void {
    this.assertPartNumbers(parts.map((part) => part.partNumber));

    for (let index = 1; index < parts.length; index += 1) {
      if (parts[index - 1].partNumber >= parts[index].partNumber) {
        throw new InvalidObjectStorageRequestError(
          'complete multipart upload',
          'Multipart parts must be ordered by ascending part number',
        );
      }
    }
  }

  private async execute<T>(
    operation: string,
    action: () => Promise<T>,
  ): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof ObjectStorageError) {
        throw error;
      }

      throw this.translateError(operation, error);
    }
  }

  private translateError(
    operation: string,
    error: unknown,
  ): ObjectStorageError {
    if (error instanceof S3ServiceException) {
      const options = { cause: error };

      if (error.name === 'NoSuchUpload') {
        return new MultipartUploadNotFoundError(
          operation,
          'Multipart upload was not found',
          options,
        );
      }

      if (
        error.name === 'NoSuchKey' ||
        error.$metadata.httpStatusCode === 404
      ) {
        return new ObjectStorageNotFoundError(
          operation,
          'Object was not found',
          options,
        );
      }

      if (
        [
          'InvalidArgument',
          'InvalidPart',
          'InvalidPartOrder',
          'EntityTooSmall',
        ].includes(error.name)
      ) {
        return new InvalidObjectStorageRequestError(
          operation,
          error.message,
          options,
        );
      }

      return new ObjectStorageUnavailableError(
        operation,
        `Object storage request failed: ${error.name}`,
        options,
      );
    }

    return new ObjectStorageUnavailableError(
      operation,
      'Object storage request failed',
      { cause: error },
    );
  }
}
