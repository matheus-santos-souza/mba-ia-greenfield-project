---
paths:
  - 'nestjs-project/src/**/*.module.ts'
description: 'NestJS module structure conventions'
---

# NestJS Module Structure

- `@Module()` property order: `imports` → `controllers` → `providers` → `exports`
- `TypeOrmModule.forFeature([...])` goes in domain module `imports`, never in `AppModule`
- **Every entity must be registered in `TypeOrmModule.forFeature([Entity])` of its owning module.** Even with `autoLoadEntities: true`, the entity is only discovered if some module imports it via `forFeature`. Forgetting this does not cause a clear error: the app starts, but any repository injection or query against the missing entity fails at runtime (or, worse, the entity is silently absent from migrations). When you create or move an entity, immediately update the owning module's imports.
- `AppModule` only contains global infrastructure (ConfigModule, TypeOrmModule) and domain modules — no business providers
- `exports` only for dependencies other modules need; don't export by default
- When a module exposes shared infrastructure (e.g., `JwtModule.registerAsync`, repository providers), it must `exports` them — and consumer test modules must include the same registration. Test modules are NestJS modules: missing imports here cause "Nest can't resolve dependencies" errors that look like production bugs but are test-setup bugs.
- Shared infrastructure modules export ports/tokens and narrowly required helpers, not concrete implementation internals. `StorageModule` exports `OBJECT_STORAGE_PORT` and `VideoStorageKeyService`; callers must not inject `S3Client` or `S3ObjectStorageService` directly.
- Queue registration belongs in `VideoProcessingQueueModule`. API publisher and worker consumer import the same configured BullMQ module; do not duplicate Redis/queue configuration in feature modules.
- A standalone worker has its own root module and bootstrap (`VideoWorkerModule` + `video-worker.ts`). It must import only processing dependencies and must not import HTTP controllers or bootstrap the Express application.
- Lifecycle loops and workers must be closed through Nest shutdown hooks. Module compilation tests that initialize TypeORM/BullMQ must call `module.close()` to release real handles.
