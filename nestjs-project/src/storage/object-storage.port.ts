import type { Readable } from 'node:stream';

export interface CreateMultipartUploadInput {
  objectKey: string;
  contentType: string;
  metadata?: Readonly<Record<string, string>>;
}

export interface MultipartUpload {
  uploadId: string;
  objectKey: string;
}

export interface SignMultipartPartsInput {
  objectKey: string;
  uploadId: string;
  partNumbers: readonly number[];
  expiresInSeconds?: number;
}

export interface PresignedMultipartPart {
  partNumber: number;
  url: string;
}

export interface MultipartPart {
  partNumber: number;
  etag: string;
  size?: number;
  checksumCrc32?: string;
  checksumCrc32C?: string;
  checksumSha1?: string;
  checksumSha256?: string;
}

export interface MultipartUploadReference {
  objectKey: string;
  uploadId: string;
}

export interface CompleteMultipartUploadInput extends MultipartUploadReference {
  parts: readonly MultipartPart[];
}

export interface StoredObjectReference {
  objectKey: string;
  etag?: string;
}

export interface GetObjectInput {
  objectKey: string;
  range?: string;
}

export interface StoredObject {
  body: Readable;
  contentLength?: number;
  contentType?: string;
  contentRange?: string;
  acceptRanges?: string;
  etag?: string;
}

export interface UploadObjectInput {
  objectKey: string;
  body: Readable;
  contentLength: number;
  contentType: string;
}

export interface StoredObjectMetadata {
  contentLength?: number;
  contentType?: string;
  etag?: string;
  lastModified?: Date;
}

export interface PresignGetObjectInput {
  objectKey: string;
  expiresInSeconds?: number;
  range?: string;
  responseContentDisposition?: string;
}

export interface ObjectStoragePort {
  createMultipartUpload(
    input: CreateMultipartUploadInput,
  ): Promise<MultipartUpload>;
  signMultipartParts(
    input: SignMultipartPartsInput,
  ): Promise<readonly PresignedMultipartPart[]>;
  listMultipartParts(
    input: MultipartUploadReference,
  ): Promise<readonly MultipartPart[]>;
  completeMultipartUpload(
    input: CompleteMultipartUploadInput,
  ): Promise<StoredObjectReference>;
  abortMultipartUpload(input: MultipartUploadReference): Promise<void>;
  getObject(input: GetObjectInput): Promise<StoredObject>;
  uploadObject(input: UploadObjectInput): Promise<StoredObjectReference>;
  headObject(objectKey: string): Promise<StoredObjectMetadata>;
  presignGetObject(input: PresignGetObjectInput): Promise<string>;
}
