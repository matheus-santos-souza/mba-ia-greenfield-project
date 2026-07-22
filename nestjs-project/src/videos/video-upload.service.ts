import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import type {
  MultipartPart,
  ObjectStoragePort,
  StoredObjectMetadata,
} from '../storage/object-storage.port';
import {
  InvalidObjectStorageRequestError,
  MultipartUploadNotFoundError,
  ObjectStorageError,
} from '../storage/storage.errors';
import { OBJECT_STORAGE_PORT } from '../storage/storage.constants';
import { VideoStorageKeyService } from '../storage/video-storage-key.service';
import { VideoUploadStatus } from './entities/video-upload.entity';
import { VideoStatus } from './entities/video.entity';
import { PublicVideoIdService } from './public-video-id.service';
import {
  InvalidUploadPartsException,
  StorageUnavailableException,
  UnsupportedVideoTypeException,
  UploadAlreadyCompletedException,
  UploadSessionExpiredException,
  UploadSessionNotActiveException,
  VideoFileTooLargeException,
} from './video.exceptions';
import { VideoOwnershipService } from './video-ownership.service';
import { VideoRepository, type VideoWithUpload } from './video.repository';

const MAX_SIGNED_PARTS_PER_REQUEST = 100;
const MAX_MULTIPART_PART_NUMBER = 10_000;

export interface InitiateVideoUploadInput {
  userId: string;
  title: string;
  fileSize: number;
  contentType: string;
}

export interface InitiateVideoUploadResult {
  video_id: string;
  public_id: string;
  upload_id: string;
  part_size: number;
  status: VideoStatus.DRAFT;
  expires_at: string;
}

export interface UploadedPartResult {
  part_number: number;
  etag: string;
  size: number;
}

export interface ResumeVideoUploadResult {
  video_id: string;
  upload_id: string;
  part_size: number;
  file_size: number;
  status: VideoUploadStatus;
  expires_at: string;
  uploaded_parts: UploadedPartResult[];
}

export interface SignedUploadPartResult {
  part_number: number;
  upload_url: string;
  expires_at: string;
}

export interface CompleteVideoUploadPart {
  part_number: number;
  etag: string;
}

export interface CompleteVideoUploadResult {
  video_id: string;
  public_id: string;
  status: VideoStatus.PROCESSING;
}

@Injectable()
export class VideoUploadService {
  constructor(
    private readonly videos: VideoRepository,
    private readonly ownership: VideoOwnershipService,
    private readonly publicIds: PublicVideoIdService,
    private readonly storageKeys: VideoStorageKeyService,
    @Inject(OBJECT_STORAGE_PORT)
    private readonly storage: ObjectStoragePort,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
    @Inject(storageConfig.KEY)
    private readonly storageSettings: ConfigType<typeof storageConfig>,
  ) {}

  async initiate(
    input: InitiateVideoUploadInput,
  ): Promise<InitiateVideoUploadResult> {
    const title = input.title.trim();
    this.assertInitiationInput(title, input.fileSize, input.contentType);
    const channel = await this.ownership.requireChannel(input.userId);
    const videoId = randomUUID();
    const objectKey = this.storageKeys.source(videoId);
    const expiresAt = new Date(
      Date.now() + this.config.uploadExpirationHours * 60 * 60 * 1_000,
    );
    const multipart = await this.runStorage(() =>
      this.storage.createMultipartUpload({
        objectKey,
        contentType: input.contentType,
        metadata: {
          'declared-file-size': String(input.fileSize),
          'declared-content-type': input.contentType,
        },
      }),
    );

    let created: VideoWithUpload;
    try {
      created = await this.publicIds.persistWithRetry((publicId) =>
        this.videos.createDraftWithUpload({
          videoId,
          channelId: channel.id,
          publicId,
          title,
          objectKey,
          uploadId: multipart.uploadId,
          fileSize: input.fileSize,
          contentType: input.contentType,
          partSize: this.config.multipartPartSizeBytes,
          expiresAt,
        }),
      );
    } catch (error) {
      try {
        await this.storage.abortMultipartUpload(multipart);
      } catch (compensationError) {
        throw new AggregateError(
          [error, compensationError],
          'Draft persistence and multipart compensation both failed',
        );
      }
      throw error;
    }

    return {
      video_id: created.video.id,
      public_id: created.video.public_id,
      upload_id: created.upload.upload_id,
      part_size: created.upload.part_size,
      status: VideoStatus.DRAFT,
      expires_at: created.upload.expires_at.toISOString(),
    };
  }

  async resume(
    userId: string,
    videoId: string,
    uploadId: string,
  ): Promise<ResumeVideoUploadResult> {
    const session = await this.ownership.requireUpload(
      userId,
      videoId,
      uploadId,
    );
    this.assertNotExpired(session);

    const parts =
      session.upload.status === VideoUploadStatus.INITIATED
        ? await this.runStorage(() =>
            this.storage.listMultipartParts(this.storageReference(session)),
          )
        : [];

    return {
      video_id: session.video.id,
      upload_id: session.upload.upload_id,
      part_size: session.upload.part_size,
      file_size: Number(session.upload.file_size),
      status: session.upload.status,
      expires_at: session.upload.expires_at.toISOString(),
      uploaded_parts: [...parts]
        .sort((left, right) => left.partNumber - right.partNumber)
        .map((part) => ({
          part_number: part.partNumber,
          etag: part.etag,
          size: part.size ?? 0,
        })),
    };
  }

  async signParts(
    userId: string,
    videoId: string,
    uploadId: string,
    partNumbers: readonly number[],
  ): Promise<{ parts: SignedUploadPartResult[] }> {
    const session = await this.requireActiveSession(userId, videoId, uploadId);
    this.assertSignablePartNumbers(session, partNumbers);
    const signedAt = Date.now();
    const expiresAt = new Date(
      signedAt + this.storageSettings.uploadPartUrlTtlSeconds * 1_000,
    ).toISOString();
    const parts = await this.runStorage(() =>
      this.storage.signMultipartParts({
        ...this.storageReference(session),
        partNumbers,
        expiresInSeconds: this.storageSettings.uploadPartUrlTtlSeconds,
      }),
    );

    return {
      parts: parts.map((part) => ({
        part_number: part.partNumber,
        upload_url: part.url,
        expires_at: expiresAt,
      })),
    };
  }

  async complete(
    userId: string,
    videoId: string,
    uploadId: string,
    submittedParts: readonly CompleteVideoUploadPart[],
  ): Promise<CompleteVideoUploadResult> {
    const session = await this.ownership.requireUpload(
      userId,
      videoId,
      uploadId,
    );
    if (session.upload.status === VideoUploadStatus.COMPLETED) {
      return this.completedResult(session);
    }
    this.assertActive(session);
    this.assertSubmittedParts(submittedParts);

    await this.ensureMultipartObjectCompleted(session, submittedParts);
    const video = await this.videos.completeUpload(
      session.video.id,
      session.upload.upload_id,
      new Date(),
    );

    return {
      video_id: video.id,
      public_id: video.public_id,
      status: VideoStatus.PROCESSING,
    };
  }

  async abort(
    userId: string,
    videoId: string,
    uploadId: string,
  ): Promise<void> {
    const session = await this.ownership.requireUpload(
      userId,
      videoId,
      uploadId,
    );
    if (session.upload.status === VideoUploadStatus.COMPLETED) {
      throw new UploadAlreadyCompletedException();
    }
    if (session.upload.status === VideoUploadStatus.ABORTED) {
      return;
    }

    try {
      await this.storage.abortMultipartUpload(this.storageReference(session));
    } catch (error) {
      if (!(error instanceof MultipartUploadNotFoundError)) {
        throw this.toStorageException(error);
      }
    }
    await this.videos.abortUpload(videoId, uploadId);
  }

  private assertInitiationInput(
    title: string,
    fileSize: number,
    contentType: string,
  ): void {
    if (title.length === 0 || title.length > 255) {
      throw new RangeError('Video title must contain between 1 and 255 chars');
    }
    if (!Number.isSafeInteger(fileSize) || fileSize < 1) {
      throw new RangeError('Video file size must be a positive integer');
    }
    if (fileSize > this.config.maxFileSizeBytes) {
      throw new VideoFileTooLargeException();
    }
    if (!this.config.allowedContentTypes.includes(contentType)) {
      throw new UnsupportedVideoTypeException();
    }
  }

  private async requireActiveSession(
    userId: string,
    videoId: string,
    uploadId: string,
  ): Promise<VideoWithUpload> {
    const session = await this.ownership.requireUpload(
      userId,
      videoId,
      uploadId,
    );
    this.assertActive(session);
    return session;
  }

  private assertActive(session: VideoWithUpload): void {
    if (session.upload.status !== VideoUploadStatus.INITIATED) {
      throw new UploadSessionNotActiveException();
    }
    this.assertNotExpired(session);
  }

  private assertNotExpired(session: VideoWithUpload): void {
    if (
      session.upload.status === VideoUploadStatus.INITIATED &&
      session.upload.expires_at.getTime() <= Date.now()
    ) {
      throw new UploadSessionExpiredException();
    }
  }

  private assertSignablePartNumbers(
    session: VideoWithUpload,
    partNumbers: readonly number[],
  ): void {
    const maximumPartNumber = Math.ceil(
      Number(session.upload.file_size) / session.upload.part_size,
    );
    if (
      partNumbers.length === 0 ||
      partNumbers.length > MAX_SIGNED_PARTS_PER_REQUEST ||
      new Set(partNumbers).size !== partNumbers.length ||
      partNumbers.some(
        (partNumber) =>
          !Number.isInteger(partNumber) ||
          partNumber < 1 ||
          partNumber > MAX_MULTIPART_PART_NUMBER ||
          partNumber > maximumPartNumber,
      )
    ) {
      throw new RangeError('Requested multipart part numbers are invalid');
    }
  }

  private assertSubmittedParts(
    submittedParts: readonly CompleteVideoUploadPart[],
  ): void {
    if (
      submittedParts.length === 0 ||
      submittedParts.length > MAX_MULTIPART_PART_NUMBER
    ) {
      throw new InvalidUploadPartsException();
    }
    for (let index = 0; index < submittedParts.length; index += 1) {
      const part = submittedParts[index];
      if (
        !Number.isInteger(part.part_number) ||
        part.part_number < 1 ||
        part.part_number > MAX_MULTIPART_PART_NUMBER ||
        part.etag.trim().length === 0 ||
        (index > 0 && submittedParts[index - 1].part_number >= part.part_number)
      ) {
        throw new InvalidUploadPartsException();
      }
    }
  }

  private async ensureMultipartObjectCompleted(
    session: VideoWithUpload,
    submittedParts: readonly CompleteVideoUploadPart[],
  ): Promise<void> {
    const reference = this.storageReference(session);
    let storedParts: readonly MultipartPart[];
    try {
      storedParts = await this.storage.listMultipartParts(reference);
    } catch (error) {
      if (error instanceof MultipartUploadNotFoundError) {
        await this.assertCompletedObjectExists(session);
        return;
      }
      throw this.toStorageException(error);
    }

    this.assertPartsMatch(session, submittedParts, storedParts);
    try {
      await this.storage.completeMultipartUpload({
        ...reference,
        parts: storedParts,
      });
    } catch (error) {
      if (error instanceof MultipartUploadNotFoundError) {
        await this.assertCompletedObjectExists(session);
        return;
      }
      if (error instanceof InvalidObjectStorageRequestError) {
        throw new InvalidUploadPartsException();
      }
      throw this.toStorageException(error);
    }
  }

  private assertPartsMatch(
    session: VideoWithUpload,
    submittedParts: readonly CompleteVideoUploadPart[],
    storedParts: readonly MultipartPart[],
  ): void {
    if (submittedParts.length !== storedParts.length) {
      throw new InvalidUploadPartsException();
    }

    let totalSize = 0;
    for (let index = 0; index < storedParts.length; index += 1) {
      const stored = storedParts[index];
      const submitted = submittedParts[index];
      if (
        stored.partNumber !== submitted.part_number ||
        stored.etag.trim() !== submitted.etag.trim() ||
        stored.size === undefined ||
        stored.size <= 0 ||
        (index < storedParts.length - 1 &&
          stored.size !== session.upload.part_size) ||
        (index === storedParts.length - 1 &&
          stored.size > session.upload.part_size)
      ) {
        throw new InvalidUploadPartsException();
      }
      totalSize += stored.size;
    }

    if (totalSize !== Number(session.upload.file_size)) {
      throw new InvalidUploadPartsException();
    }
  }

  private async assertCompletedObjectExists(
    session: VideoWithUpload,
  ): Promise<void> {
    let metadata: StoredObjectMetadata;
    try {
      metadata = await this.storage.headObject(session.upload.object_key);
    } catch (error) {
      throw this.toStorageException(error);
    }

    if (
      metadata.contentLength !== Number(session.upload.file_size) ||
      metadata.contentType !== session.upload.content_type
    ) {
      throw new InvalidUploadPartsException();
    }
  }

  private storageReference(session: VideoWithUpload): {
    objectKey: string;
    uploadId: string;
  } {
    return {
      objectKey: session.upload.object_key,
      uploadId: session.upload.upload_id,
    };
  }

  private completedResult(session: VideoWithUpload): CompleteVideoUploadResult {
    return {
      video_id: session.video.id,
      public_id: session.video.public_id,
      status: VideoStatus.PROCESSING,
    };
  }

  private async runStorage<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw this.toStorageException(error);
    }
  }

  private toStorageException(error: unknown): Error {
    return error instanceof ObjectStorageError
      ? new StorageUnavailableException()
      : error instanceof Error
        ? error
        : new StorageUnavailableException();
  }
}
