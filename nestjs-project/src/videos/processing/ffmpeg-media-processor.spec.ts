import type { ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access, writeFile } from 'node:fs/promises';
import { PassThrough, Readable } from 'node:stream';
import videoConfig from '../../config/video.config';
import {
  FfmpegMediaProcessor,
  MEDIA_PROCESS_SPAWNER,
  type MediaProcessSpawner,
} from './ffmpeg-media-processor';

interface FakeProcess extends ChildProcessWithoutNullStreams {
  kill: jest.Mock<boolean, [NodeJS.Signals?]>;
}

const probeOutput = JSON.stringify({
  streams: [
    {
      codec_type: 'video',
      codec_name: 'h264',
      width: 320,
      height: 180,
    },
  ],
  format: {
    format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    duration: '2.500000',
    bit_rate: '48000',
    size: '15000',
  },
});

function createFakeProcess(onKill?: (child: FakeProcess) => void): FakeProcess {
  const child = new EventEmitter() as FakeProcess;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = jest.fn(() => {
    onKill?.(child);
    return true;
  });
  return child;
}

describe('FfmpegMediaProcessor', () => {
  let module: TestingModule;
  let processor: FfmpegMediaProcessor;
  let spawnProcess: jest.MockedFunction<MediaProcessSpawner>;
  const config = {
    ffmpegPath: '/usr/bin/ffmpeg',
    ffprobePath: '/usr/bin/ffprobe',
    processingTimeoutSeconds: 30,
  } as ConfigType<typeof videoConfig>;

  beforeEach(async () => {
    spawnProcess = jest.fn();
    module = await Test.createTestingModule({
      providers: [
        FfmpegMediaProcessor,
        { provide: videoConfig.KEY, useValue: config },
        { provide: MEDIA_PROCESS_SPAWNER, useValue: spawnProcess },
      ],
    }).compile();
    processor = module.get(FfmpegMediaProcessor);
  });

  afterEach(async () => {
    await module.close();
  });

  it('uses argument arrays for probe, H.264/AAC faststart and midpoint JPEG generation', async () => {
    spawnProcess.mockImplementation((command, args) => {
      const child = createFakeProcess();
      process.nextTick(() => {
        if (command.endsWith('ffprobe')) {
          (child.stdout as PassThrough).end(probeOutput);
          child.emit('close', 0, null);
          return;
        }

        const outputPath = args.at(-1);
        if (!outputPath) {
          child.emit('close', 1, null);
          return;
        }
        void writeFile(outputPath, Buffer.from('artifact')).then(() => {
          child.emit('close', 0, null);
        });
      });
      return child;
    });

    let playbackPath = '';
    let thumbnailPath = '';
    const result = await processor.withProcessedMedia(
      Readable.from(Buffer.from('source-video')),
      async (media) => {
        playbackPath = media.playback.path;
        thumbnailPath = media.thumbnail.path;
        return media;
      },
    );

    expect(result.durationSeconds).toBe('2.500');
    expect(result.metadata).toEqual({
      format: 'mov,mp4,m4a,3gp,3g2,mj2',
      codec: 'h264',
      width: 320,
      height: 180,
      bit_rate: 48000,
      size_bytes: 15000,
    });
    expect(spawnProcess).toHaveBeenNthCalledWith(
      2,
      '/usr/bin/ffmpeg',
      expect.arrayContaining([
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
      ]),
    );
    expect(spawnProcess).toHaveBeenNthCalledWith(
      3,
      '/usr/bin/ffmpeg',
      expect.arrayContaining(['-ss', '1.250', '-frames:v', '1']),
    );
    await expect(access(playbackPath)).rejects.toThrow();
    await expect(access(thumbnailPath)).rejects.toThrow();
  });

  it('reports process failures without exposing captured stderr in the error message and cleans temp files', async () => {
    let sourcePath = '';
    spawnProcess.mockImplementation((_command, args) => {
      sourcePath = args.at(-1) ?? '';
      const child = createFakeProcess();
      process.nextTick(() => {
        (child.stderr as PassThrough).end(
          'private /tmp/path and command details',
        );
        child.emit('close', 1, null);
      });
      return child;
    });

    await expect(
      processor.withProcessedMedia(Readable.from('bad-video'), async () => {}),
    ).rejects.toThrow('ffprobe exited unsuccessfully');
    await expect(access(sourcePath)).rejects.toThrow();
  });

  it('kills a command that exceeds the configured timeout', async () => {
    const timeoutConfig = { ...config, processingTimeoutSeconds: 0 };
    await module.close();
    const timeoutModule = await Test.createTestingModule({
      providers: [
        FfmpegMediaProcessor,
        { provide: videoConfig.KEY, useValue: timeoutConfig },
        { provide: MEDIA_PROCESS_SPAWNER, useValue: spawnProcess },
      ],
    }).compile();
    module = timeoutModule;
    processor = module.get(FfmpegMediaProcessor);
    const child = createFakeProcess((processRef) => {
      process.nextTick(() => processRef.emit('close', null, 'SIGKILL'));
    });
    spawnProcess.mockReturnValue(child);

    await expect(
      processor.withProcessedMedia(Readable.from('slow-video'), async () => {}),
    ).rejects.toThrow('ffprobe timed out');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
