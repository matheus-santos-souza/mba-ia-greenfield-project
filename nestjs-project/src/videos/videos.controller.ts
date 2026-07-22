import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtension,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteVideoUploadDto } from './dto/complete-video-upload.dto';
import { InitiateVideoUploadDto } from './dto/initiate-video-upload.dto';
import {
  PUBLIC_VIDEO_ID_PATTERN,
  PublicVideoIdParamDto,
} from './dto/public-video-id-param.dto';
import { SignVideoUploadPartsDto } from './dto/sign-video-upload-parts.dto';
import {
  CompleteVideoUploadResponseDto,
  InitiateVideoUploadResponseDto,
  ResumeVideoUploadResponseDto,
  SignVideoUploadPartsResponseDto,
} from './dto/video-upload-response.dto';
import { VideoUploadParamsDto } from './dto/video-upload-params.dto';
import { VideoDeliveryService } from './video-delivery.service';
import { VideoUploadService } from './video-upload.service';

const errorSchema = { $ref: getSchemaPath(ApiErrorEnvelope) };
const publicVideoIdSchema = {
  type: 'string',
  minLength: 21,
  maxLength: 21,
  pattern: PUBLIC_VIDEO_ID_PATTERN,
  example: 'V1d3oAbCdEfGhIjKlMnOp',
};
const redirectHeaders = {
  Location: {
    description: 'Short-lived presigned GET URL for the canonical MP4.',
    schema: { type: 'string', format: 'uri' },
  },
};
const streamRedirectTarget = {
  method: 'GET',
  description:
    'Object storage serves the canonical playback MP4 and honors a preserved Range header.',
  responses: {
    '200': {
      description: 'Complete playback object when Range is omitted.',
      headers: {
        'Accept-Ranges': { schema: { type: 'string', enum: ['bytes'] } },
        'Content-Length': { schema: { type: 'integer', minimum: 0 } },
        'Content-Type': { schema: { type: 'string', example: 'video/mp4' } },
      },
    },
    '206': {
      description: 'Requested satisfiable byte range.',
      headers: {
        'Accept-Ranges': { schema: { type: 'string', enum: ['bytes'] } },
        'Content-Range': {
          schema: { type: 'string', example: 'bytes 0-1023/2048' },
        },
        'Content-Length': { schema: { type: 'integer', minimum: 1 } },
        'Content-Type': { schema: { type: 'string', example: 'video/mp4' } },
      },
    },
  },
};
const downloadRedirectTarget = {
  method: 'GET',
  description:
    'Object storage serves the canonical MP4 as an attachment named from the public video ID.',
  responses: {
    '200': {
      description: 'Complete playback object as a download.',
      headers: {
        'Content-Disposition': {
          schema: {
            type: 'string',
            example: 'attachment; filename="V1d3oAbCdEfGhIjKlMnOp.mp4"',
          },
        },
        'Content-Length': { schema: { type: 'integer', minimum: 0 } },
        'Content-Type': { schema: { type: 'string', example: 'video/mp4' } },
      },
    },
  },
};

@ApiTags('videos')
@ApiBearerAuth('access-token')
@Controller('videos')
export class VideosController {
  constructor(
    private readonly uploads: VideoUploadService,
    private readonly delivery: VideoDeliveryService,
  ) {}

  @Post('uploads')
  @ApiOperation({
    summary: 'Start a multipart video upload',
    description:
      'Creates a draft video and an S3-compatible multipart upload owned by the authenticated user channel.',
  })
  @ApiResponse({
    status: 201,
    description: 'Multipart upload started',
    type: InitiateVideoUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Authentication required',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 403,
    description: 'Channel ownership required',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 413,
    description: 'Video file is too large',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 415,
    description: 'Video media type is unsupported',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 503,
    description: 'Object storage is unavailable',
    schema: errorSchema,
  })
  async initiate(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateVideoUploadDto,
  ): Promise<InitiateVideoUploadResponseDto> {
    return this.uploads.initiate({
      userId: user.sub,
      title: dto.title,
      fileSize: dto.file_size,
      contentType: dto.content_type,
    });
  }

  @Get(':videoId/uploads/:uploadId')
  @ApiOperation({
    summary: 'Resume a multipart video upload',
    description:
      'Returns the persisted upload session and the authoritative parts currently stored in object storage.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload session returned',
    type: ResumeVideoUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Authentication required',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 403,
    description: 'Video ownership required',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Upload session not found',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 410,
    description: 'Upload session expired',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 503,
    description: 'Object storage is unavailable',
    schema: errorSchema,
  })
  async resume(
    @CurrentUser() user: JwtPayload,
    @Param() params: VideoUploadParamsDto,
  ): Promise<ResumeVideoUploadResponseDto> {
    return this.uploads.resume(user.sub, params.videoId, params.uploadId);
  }

  @Post(':videoId/uploads/:uploadId/parts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign multipart upload parts',
    description:
      'Creates short-lived presigned URLs so the client can upload selected parts directly to object storage.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload part URLs signed',
    type: SignVideoUploadPartsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Authentication required',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 403,
    description: 'Video ownership required',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Upload session not found',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Upload session is not active',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 410,
    description: 'Upload session expired',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 503,
    description: 'Object storage is unavailable',
    schema: errorSchema,
  })
  async signParts(
    @CurrentUser() user: JwtPayload,
    @Param() params: VideoUploadParamsDto,
    @Body() dto: SignVideoUploadPartsDto,
  ): Promise<SignVideoUploadPartsResponseDto> {
    return this.uploads.signParts(
      user.sub,
      params.videoId,
      params.uploadId,
      dto.part_numbers,
    );
  }

  @Post(':videoId/uploads/:uploadId/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Complete a multipart video upload',
    description:
      'Verifies and completes the multipart object, then atomically requests asynchronous video processing.',
  })
  @ApiResponse({
    status: 202,
    description: 'Upload completed and processing requested',
    type: CompleteVideoUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Upload part manifest is invalid',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Authentication required',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 403,
    description: 'Video ownership required',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Upload session not found',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Upload session is not active',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 410,
    description: 'Upload session expired',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 503,
    description: 'Object storage is unavailable',
    schema: errorSchema,
  })
  async complete(
    @CurrentUser() user: JwtPayload,
    @Param() params: VideoUploadParamsDto,
    @Body() dto: CompleteVideoUploadDto,
  ): Promise<CompleteVideoUploadResponseDto> {
    return this.uploads.complete(
      user.sub,
      params.videoId,
      params.uploadId,
      dto.parts,
    );
  }

  @Delete(':videoId/uploads/:uploadId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Abort a multipart video upload',
    description:
      'Aborts an active multipart upload and records the terminal session state. Repeated aborts are idempotent.',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted' })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Authentication required',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 403,
    description: 'Video ownership required',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Upload session not found',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Upload is already complete',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 503,
    description: 'Object storage is unavailable',
    schema: errorSchema,
  })
  async abort(
    @CurrentUser() user: JwtPayload,
    @Param() params: VideoUploadParamsDto,
  ): Promise<void> {
    return this.uploads.abort(user.sub, params.videoId, params.uploadId);
  }

  @Get(':publicId/stream')
  @HttpCode(HttpStatus.TEMPORARY_REDIRECT)
  @ApiOperation({
    summary: 'Stream a ready video',
    description:
      'Authorizes the owner and redirects to a short-lived URL for the canonical playback MP4. A Range header can be preserved when following the 307 redirect.',
  })
  @ApiParam({ name: 'publicId', required: true, schema: publicVideoIdSchema })
  @ApiHeader({
    name: 'Range',
    required: false,
    description: 'Optional byte range preserved when following the redirect.',
    schema: { type: 'string', pattern: '^bytes=\\d*-\\d*$' },
    example: 'bytes=0-1023',
  })
  @ApiExtension('x-redirect-target', streamRedirectTarget)
  @ApiResponse({
    status: 307,
    description: 'Temporary redirect to the canonical playback object',
    headers: redirectHeaders,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Authentication required',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 403,
    description: 'Video ownership required',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 503,
    description: 'Object storage is unavailable',
    schema: errorSchema,
  })
  async stream(
    @CurrentUser() user: JwtPayload,
    @Param() params: PublicVideoIdParamDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const location = await this.delivery.createStreamRedirect(
      user.sub,
      params.publicId,
    );
    response.setHeader('Location', location);
  }

  @Get(':publicId/download')
  @HttpCode(HttpStatus.TEMPORARY_REDIRECT)
  @ApiOperation({
    summary: 'Download a ready video',
    description:
      'Authorizes the owner and redirects to a short-lived URL that serves the canonical MP4 as a public-ID attachment.',
  })
  @ApiParam({ name: 'publicId', required: true, schema: publicVideoIdSchema })
  @ApiExtension('x-redirect-target', downloadRedirectTarget)
  @ApiResponse({
    status: 307,
    description: 'Temporary redirect to the canonical playback attachment',
    headers: redirectHeaders,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Authentication required',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 403,
    description: 'Video ownership required',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 503,
    description: 'Object storage is unavailable',
    schema: errorSchema,
  })
  async download(
    @CurrentUser() user: JwtPayload,
    @Param() params: PublicVideoIdParamDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const location = await this.delivery.createDownloadRedirect(
      user.sub,
      params.publicId,
    );
    response.setHeader('Location', location);
  }
}
