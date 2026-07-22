import { NestFactory } from '@nestjs/core';
import { VideoWorkerModule } from './videos/processing/video-worker.module';

async function bootstrap(): Promise<void> {
  const application =
    await NestFactory.createApplicationContext(VideoWorkerModule);
  application.enableShutdownHooks();
}

void bootstrap();
