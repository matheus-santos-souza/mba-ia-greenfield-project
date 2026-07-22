export abstract class ObjectStorageError extends Error {
  constructor(
    public readonly operation: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

export class ObjectStorageNotFoundError extends ObjectStorageError {}

export class MultipartUploadNotFoundError extends ObjectStorageError {}

export class InvalidObjectStorageRequestError extends ObjectStorageError {}

export class ObjectStorageUnavailableError extends ObjectStorageError {}
