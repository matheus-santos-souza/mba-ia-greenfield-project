import { Test, type TestingModule } from '@nestjs/testing';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadStream } from 'node:fs';
import videoConfig from '../../config/video.config';
import {
  FfmpegMediaProcessor,
  MEDIA_PROCESS_SPAWNER,
  spawnMediaProcess,
} from './ffmpeg-media-processor';

interface ProbedStream {
  codec_type?: string;
  codec_name?: string;
  pix_fmt?: string;
}

interface PlaybackProbe {
  streams?: ProbedStream[];
}

function run(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(new Error(error.message, { cause: error }));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

describe('FfmpegMediaProcessor (integration)', () => {
  let module: TestingModule;
  let processor: FfmpegMediaProcessor;
  let directory: string;
  let sourcePath: string;
  const ffmpegPath = process.env.FFMPEG_PATH ?? '/usr/bin/ffmpeg';
  const ffprobePath = process.env.FFPROBE_PATH ?? '/usr/bin/ffprobe';

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ffmpeg-integration-'));
    sourcePath = join(directory, 'fixture.mov');
    await run(ffmpegPath, [
      '-nostdin',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=160x120:r=10',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=1000:sample_rate=44100',
      '-t',
      '1',
      '-shortest',
      '-c:v',
      'mpeg4',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      sourcePath,
    ]);

    module = await Test.createTestingModule({
      providers: [
        FfmpegMediaProcessor,
        {
          provide: videoConfig.KEY,
          useValue: {
            ffmpegPath,
            ffprobePath,
            processingTimeoutSeconds: 30,
          },
        },
        { provide: MEDIA_PROCESS_SPAWNER, useValue: spawnMediaProcess },
      ],
    }).compile();
    processor = module.get(FfmpegMediaProcessor);
  }, 30_000);

  afterAll(async () => {
    await module.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('creates probeable H.264/AAC faststart MP4, JPEG and normalized metadata', async () => {
    const result = await processor.withProcessedMedia(
      createReadStream(sourcePath),
      async (media) => {
        const playbackProbe = JSON.parse(
          await run(ffprobePath, [
            '-v',
            'error',
            '-print_format',
            'json',
            '-show_streams',
            media.playback.path,
          ]),
        ) as PlaybackProbe;
        const playbackBytes = await readFile(media.playback.path);
        const thumbnailBytes = await readFile(media.thumbnail.path);
        return { media, playbackProbe, playbackBytes, thumbnailBytes };
      },
    );

    const videoStream = result.playbackProbe.streams?.find(
      (stream) => stream.codec_type === 'video',
    );
    const audioStream = result.playbackProbe.streams?.find(
      (stream) => stream.codec_type === 'audio',
    );
    expect(videoStream).toEqual(
      expect.objectContaining({ codec_name: 'h264', pix_fmt: 'yuv420p' }),
    );
    expect(audioStream?.codec_name).toBe('aac');
    expect(result.playbackBytes.indexOf(Buffer.from('moov'))).toBeGreaterThan(
      0,
    );
    expect(result.playbackBytes.indexOf(Buffer.from('moov'))).toBeLessThan(
      result.playbackBytes.indexOf(Buffer.from('mdat')),
    );
    expect(result.thumbnailBytes.subarray(0, 3)).toEqual(
      Buffer.from([0xff, 0xd8, 0xff]),
    );
    expect(Number(result.media.durationSeconds)).toBeGreaterThan(0);
    expect(result.media.metadata).toEqual({
      format: expect.any(String),
      codec: 'mpeg4',
      width: 160,
      height: 120,
      bit_rate: expect.any(Number),
      size_bytes: expect.any(Number),
    });
  }, 30_000);
});
