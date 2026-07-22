import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import videoConfig from '../../config/video.config';
import type { VideoMetadata } from '../entities/video.entity';
import {
  MediaProcessorPort,
  type ProcessedMedia,
  type ProcessedMediaArtifact,
} from './media-processor.port';

const STDERR_LIMIT_BYTES = 16 * 1024;
const STDOUT_LIMIT_BYTES = 1024 * 1024;

export const MEDIA_PROCESS_SPAWNER = Symbol('MEDIA_PROCESS_SPAWNER');

export type MediaProcessSpawner = (
  command: string,
  args: readonly string[],
) => ChildProcessWithoutNullStreams;

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface FfprobeStream {
  codec_type?: unknown;
  codec_name?: unknown;
  width?: unknown;
  height?: unknown;
}

interface FfprobeFormat {
  format_name?: unknown;
  duration?: unknown;
  bit_rate?: unknown;
  size?: unknown;
}

interface FfprobeOutput {
  streams?: unknown;
  format?: unknown;
}

export class MediaProcessingError extends Error {
  constructor(
    message: string,
    readonly diagnostic: string,
  ) {
    super(message);
    this.name = 'MediaProcessingError';
  }
}

@Injectable()
export class FfmpegMediaProcessor extends MediaProcessorPort {
  private readonly activeProcesses = new Set<ChildProcessWithoutNullStreams>();

  constructor(
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
    @Inject(MEDIA_PROCESS_SPAWNER)
    private readonly spawnProcess: MediaProcessSpawner,
  ) {
    super();
  }

  async withProcessedMedia<T>(
    source: Readable,
    consume: (media: ProcessedMedia) => Promise<T>,
  ): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), 'streamtube-video-'));
    const sourcePath = join(directory, 'source');
    const playbackPath = join(directory, 'playback.mp4');
    const thumbnailPath = join(directory, 'thumbnail.jpg');

    try {
      await pipeline(source, createWriteStream(sourcePath));

      const probe = await this.runCommand(this.config.ffprobePath, [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        sourcePath,
      ]);
      const normalized = this.normalizeProbe(probe.stdout);

      await this.runCommand(this.config.ffmpegPath, [
        '-nostdin',
        '-y',
        '-i',
        sourcePath,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
        playbackPath,
      ]);
      await this.runCommand(this.config.ffmpegPath, [
        '-nostdin',
        '-y',
        '-ss',
        this.thumbnailTimestamp(normalized.durationSeconds),
        '-i',
        sourcePath,
        '-frames:v',
        '1',
        '-q:v',
        '2',
        thumbnailPath,
      ]);

      const playback = await this.artifact(playbackPath, 'video/mp4');
      const thumbnail = await this.artifact(thumbnailPath, 'image/jpeg');

      return await consume({
        durationSeconds: normalized.durationSeconds,
        metadata: normalized.metadata,
        playback,
        thumbnail,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  terminateActiveProcesses(): void {
    for (const process of this.activeProcesses) {
      process.kill('SIGKILL');
    }
  }

  private async runCommand(
    command: string,
    args: readonly string[],
  ): Promise<CommandResult> {
    const child = this.spawnProcess(command, args);
    this.activeProcesses.add(child);

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let timedOut = false;

    child.stdout.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdoutBytes += Buffer.byteLength(text);
      if (stdoutBytes <= STDOUT_LIMIT_BYTES) {
        stdout += text;
      }
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      const remaining = STDERR_LIMIT_BYTES - Buffer.byteLength(stderr);
      if (remaining > 0) {
        stderr += Buffer.from(text).subarray(0, remaining).toString();
      }
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, this.config.processingTimeoutSeconds * 1_000);

    try {
      return await new Promise<CommandResult>((resolve, reject) => {
        child.once('error', (error) => {
          reject(
            new MediaProcessingError(
              `Unable to start ${this.commandName(command)}`,
              error.message,
            ),
          );
        });
        child.once('close', (code, signal) => {
          if (timedOut) {
            reject(
              new MediaProcessingError(
                `${this.commandName(command)} timed out`,
                stderr,
              ),
            );
            return;
          }
          if (stdoutBytes > STDOUT_LIMIT_BYTES) {
            reject(
              new MediaProcessingError(
                `${this.commandName(command)} output exceeded the limit`,
                stderr,
              ),
            );
            return;
          }
          if (code !== 0) {
            reject(
              new MediaProcessingError(
                `${this.commandName(command)} exited unsuccessfully`,
                `${stderr}\nexit=${String(code)} signal=${String(signal)}`,
              ),
            );
            return;
          }
          resolve({ stdout, stderr });
        });
      });
    } finally {
      clearTimeout(timeout);
      this.activeProcesses.delete(child);
    }
  }

  private normalizeProbe(stdout: string): {
    durationSeconds: string;
    metadata: VideoMetadata;
  } {
    let parsed: FfprobeOutput;
    try {
      parsed = JSON.parse(stdout) as FfprobeOutput;
    } catch (error) {
      throw new MediaProcessingError(
        'ffprobe returned invalid JSON',
        error instanceof Error ? error.message : 'Unknown JSON error',
      );
    }

    const streams = Array.isArray(parsed.streams)
      ? (parsed.streams as FfprobeStream[])
      : [];
    const format = this.objectValue<FfprobeFormat>(parsed.format);
    const videoStream = streams.find((stream) => stream.codec_type === 'video');

    if (!videoStream || !format) {
      throw new MediaProcessingError(
        'ffprobe did not return required video metadata',
        'Missing video stream or format',
      );
    }

    const duration = this.nonNegativeNumber(format.duration, 'duration');
    const width = this.positiveInteger(videoStream.width, 'width');
    const height = this.positiveInteger(videoStream.height, 'height');
    const bitRate = this.nonNegativeInteger(format.bit_rate, 'bit_rate');
    const sizeBytes = this.positiveInteger(format.size, 'size');
    const formatName = this.nonEmptyString(format.format_name, 'format_name');
    const codecName = this.nonEmptyString(videoStream.codec_name, 'codec_name');

    return {
      durationSeconds: duration.toFixed(3),
      metadata: {
        format: formatName,
        codec: codecName,
        width,
        height,
        bit_rate: bitRate,
        size_bytes: sizeBytes,
      },
    };
  }

  private thumbnailTimestamp(durationSeconds: string): string {
    return (Number(durationSeconds) / 2).toFixed(3);
  }

  private async artifact(
    path: string,
    contentType: string,
  ): Promise<ProcessedMediaArtifact> {
    const details = await stat(path);
    if (!details.isFile() || details.size <= 0) {
      throw new MediaProcessingError(
        'FFmpeg did not create the expected artifact',
        path,
      );
    }
    return { path, contentLength: details.size, contentType };
  }

  private objectValue<T extends object>(value: unknown): T | null {
    return typeof value === 'object' && value !== null ? (value as T) : null;
  }

  private nonEmptyString(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new MediaProcessingError(
        `ffprobe returned invalid ${field}`,
        String(value),
      );
    }
    return value;
  }

  private nonNegativeNumber(value: unknown, field: string): number {
    const numberValue =
      typeof value === 'number' || typeof value === 'string'
        ? Number(value)
        : Number.NaN;
    if (!Number.isFinite(numberValue) || numberValue < 0) {
      throw new MediaProcessingError(
        `ffprobe returned invalid ${field}`,
        String(value),
      );
    }
    return numberValue;
  }

  private nonNegativeInteger(value: unknown, field: string): number {
    const numberValue = this.nonNegativeNumber(value, field);
    if (!Number.isSafeInteger(numberValue)) {
      throw new MediaProcessingError(
        `ffprobe returned invalid ${field}`,
        String(value),
      );
    }
    return numberValue;
  }

  private positiveInteger(value: unknown, field: string): number {
    const numberValue = this.nonNegativeInteger(value, field);
    if (numberValue <= 0) {
      throw new MediaProcessingError(
        `ffprobe returned invalid ${field}`,
        String(value),
      );
    }
    return numberValue;
  }

  private commandName(command: string): string {
    return command.split('/').at(-1) ?? command;
  }
}

export const spawnMediaProcess: MediaProcessSpawner = (command, args) =>
  spawn(command, [...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as unknown as ChildProcessWithoutNullStreams;
