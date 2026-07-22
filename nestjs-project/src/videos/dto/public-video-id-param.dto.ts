import { Matches } from 'class-validator';

export const PUBLIC_VIDEO_ID_PATTERN = '^[A-Za-z0-9_-]{21}$';

export class PublicVideoIdParamDto {
  /** Public 21-character URL-safe Nano ID. */
  @Matches(new RegExp(PUBLIC_VIDEO_ID_PATTERN), {
    message: 'publicId must be a 21-character URL-safe Nano ID',
  })
  publicId: string;
}
