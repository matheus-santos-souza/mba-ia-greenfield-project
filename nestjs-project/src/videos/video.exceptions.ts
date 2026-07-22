import { DomainException } from '../common/exceptions/domain.exception';

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video was not found');
  }
}

export class VideoAccessDeniedException extends DomainException {
  constructor() {
    super('VIDEO_ACCESS_DENIED', 403, 'Video access is denied');
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready');
  }
}

export class VideoFileTooLargeException extends DomainException {
  constructor() {
    super('VIDEO_FILE_TOO_LARGE', 413, 'Video file is too large');
  }
}

export class UnsupportedVideoTypeException extends DomainException {
  constructor() {
    super('UNSUPPORTED_VIDEO_TYPE', 415, 'Video content type is unsupported');
  }
}

export class UploadSessionNotFoundException extends DomainException {
  constructor() {
    super('UPLOAD_SESSION_NOT_FOUND', 404, 'Upload session was not found');
  }
}

export class UploadSessionExpiredException extends DomainException {
  constructor() {
    super('UPLOAD_SESSION_EXPIRED', 410, 'Upload session has expired');
  }
}

export class UploadSessionNotActiveException extends DomainException {
  constructor() {
    super('UPLOAD_SESSION_NOT_ACTIVE', 409, 'Upload session is not active');
  }
}

export class UploadAlreadyCompletedException extends DomainException {
  constructor() {
    super('UPLOAD_ALREADY_COMPLETED', 409, 'Upload is already completed');
  }
}

export class InvalidUploadPartsException extends DomainException {
  constructor() {
    super('INVALID_UPLOAD_PARTS', 400, 'Multipart upload parts are invalid');
  }
}

export class StorageUnavailableException extends DomainException {
  constructor() {
    super('STORAGE_UNAVAILABLE', 503, 'Object storage is unavailable');
  }
}
