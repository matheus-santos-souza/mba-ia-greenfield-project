---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-20 23:11:29.161758528 -0400"
  docs/phases/phase-03-videos/library-refs.md: "2026-07-20 23:14:00.191491577 -0400"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-20 23:08:43.240042604 -0400"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-07-20 16:38:02.707281140 -0400"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar no backend o armazenamento S3-compatible, upload multipart retomável de arquivos de até 10GB com pré-cadastro em rascunho, processamento assíncrono por worker para extração de metadados e thumbnail, identificador público único e acesso ao artefato pronto por streaming parcial e download.

---

## Step Implementations

### SI-03.1 — Provisionar infraestrutura de mídia e fila

**Description:** Preparar dependências, configuração validada e serviços Docker compartilhados pela API e pelo worker, mantendo ambos no mesmo `nestjs-project`.

**Technical actions:**

1. Atualizar `package.json` e `package-lock.json` com `@aws-sdk/client-s3@^3.1091.0`, `@aws-sdk/s3-request-presigner@^3.1091.0`, `@nestjs/bullmq@^11.0.4`, `bullmq@^5.80.9` e `nanoid@^5.1.16`; adicionar scripts de bootstrap/build do worker sem criar outro projeto (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`, `phase-03-videos/TD-04`, `phase-03-videos/TD-08`, `phase-03-videos/TD-09`).
2. Criar `src/config/storage.config.ts`, `src/config/queue.config.ts` e `src/config/video.config.ts` via `registerAs`, carregá-los em `AppModule` e ampliar `env.validation.ts` para bucket/credenciais/TTL, endpoints interno e público, Redis, fila, limite de 10GB, tamanho de parte, expiração, concorrência e caminhos FFmpeg/FFprobe.
3. Atualizar `Dockerfile.dev` para instalar `ffmpeg`/`ffprobe` e garantir que API e worker usem a mesma imagem Node 25 com encerramento por sinal.
4. Expandir `compose.yaml` com `minio`, inicializador idempotente do bucket privado, `redis` e `video-worker`; usar exclusivamente `db`, `minio` e `redis` como hosts internos, healthchecks e `depends_on` por saúde.
5. Separar `STORAGE_INTERNAL_ENDPOINT=http://minio:9000` para operações server-side de `STORAGE_PUBLIC_ENDPOINT` roteável pelo cliente para assinatura, habilitar shutdown hooks no bootstrap HTTP e documentar variáveis/readiness no backend.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Configuração de storage/queue/video | Integration: defaults, coerção e falha rápida para env inválida | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose -f nestjs-project/compose.yaml up -d` deixa `db`, `minio` e `redis` saudáveis e inicia `nestjs-api` e `video-worker` como processos distintos.
- A partir dos containers, PostgreSQL, object storage e fila são alcançados pelos hosts `db`, `minio` e `redis`, sem uso de `localhost` para comunicação interna.
- Uma configuração sem credenciais de storage, com TTL não positivo ou limite acima de 10GB impede o bootstrap com erro de validação.
- `ffmpeg -version` e `ffprobe -version` executam com sucesso no container `video-worker`.
- Uma URL presigned emitida localmente usa o endpoint público configurado, enquanto chamadas server-side continuam usando `http://minio:9000`.

---

---

### SI-03.2 — Persistir vídeos, uploads e outbox

**Description:** Materializar o modelo relacional que sustenta identidade, ownership, retomada multipart, lifecycle de processamento e publicação confiável.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts`, `video-upload.entity.ts`, `video-processing-outbox.entity.ts` e enums correspondentes com os campos, tipos, relações e índices definidos em `### Data Model` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-06`, `phase-03-videos/TD-09`).
2. Atualizar `Channel` com a relação inversa `videos`, sem cascade de persistência/remoção pelo ORM; manter ownership ancorado em `channels.user_id`.
3. Gerar e revisar uma migration reversível `CreateVideosUploadsAndProcessingOutbox`, incluindo enums, FKs, constraints e índices nomeados; o `down()` remove objetos na ordem inversa.
4. Criar `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video, VideoUpload, VideoProcessingOutbox])`, encapsulando e exportando somente providers/contratos requeridos por outros runtimes.
5. Atualizar `create-test-data-source.ts`, limpeza de tabelas e `migrations.integration-spec.ts` para incluir as novas entidades, enums, migration e ordem correta de teardown.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: defaults, enum, FK, `public_id` unique e indexes observáveis | `src/videos/entities/video.entity.integration-spec.ts` |
| `VideoUpload` | Integration: unicidade por vídeo/upload, expiração e integridade relacional | `src/videos/entities/video-upload.entity.integration-spec.ts` |
| `VideoProcessingOutbox` | Integration: payload JSONB, defaults e evento único por vídeo | `src/videos/entities/video-processing-outbox.entity.integration-spec.ts` |
| `Channel` | Integration: relação inversa e cascade no banco | `src/channels/entities/channel.entity.integration-spec.ts` |
| Migration de vídeos | Integration: `up()` completo e `down()` reversível | `src/database/migrations.integration-spec.ts` |

**Dependencies:** SI-03.1 — dependências/configuração devem preceder o novo módulo

**Acceptance criteria:**

- Executar migrations cria `videos`, `video_uploads` e `video_processing_outbox` com todas as constraints da seção Data Model.
- Criar um vídeo válido persiste `status = draft`, UUID, timestamps e relação com o canal.
- Inserir dois vídeos com o mesmo `public_id` é rejeitado pela constraint única do PostgreSQL.
- Um vídeo não aceita mais de uma sessão multipart e não aceita dois eventos `video.processing.requested`.
- Reverter a migration remove tabelas, índices e enums desta fase sem remover tabelas das fases anteriores.

---

### SI-03.3 — Implementar boundary S3-compatible

**Description:** Encapsular o controle multipart, leitura/escrita de objetos e presigning em um módulo de storage substituível, testado contra MinIO real.

**Technical actions:**

1. Definir `ObjectStoragePort`, tokens de DI e tipos estritos para create/list/sign/complete/abort multipart, streaming de objeto, upload de artefato, head e presigned GET; não expor tipos SDK ao domínio.
2. Implementar `S3ObjectStorageService` com `S3Client` e os comandos individuais documentados no cache, usando cliente interno para I/O e cliente com endpoint público para `getSignedUrl` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-08`).
3. Implementar `VideoStorageKeyService` para as chaves determinísticas de source, playback e thumbnail definidas em `### Data Model`, sem incorporar título/nome de arquivo (per `phase-03-videos/TD-02`).
4. Criar `StorageModule` com `S3Client`/port providers configurados, exportar somente `ObjectStoragePort` e `VideoStorageKeyService`, e fechar clientes no lifecycle Nest.
5. Traduzir falhas conhecidas do SDK no boundary para erros tipados de storage, preservar `ETag`/`PartNumber`, limitar listas presigned e trabalhar com streams/arquivos em vez de buffers de vídeo completos.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoStorageKeyService` | Unit: chaves determinísticas e independentes de input do usuário | `src/storage/video-storage-key.service.spec.ts` |
| `S3ObjectStorageService` | Integration: multipart, presigning, Range, abort e artefatos contra MinIO | `src/storage/s3-object-storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilação DI com configuração S3-compatible | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 — MinIO e configuração precisam estar disponíveis

**Acceptance criteria:**

- Criar uma sessão, enviar partes pelas URLs assinadas, listar partes e completar o multipart produz exatamente o objeto esperado no bucket privado.
- Abortar uma sessão ativa impede sua conclusão e remove as partes pendentes do MinIO.
- Source, playback e thumbnail do mesmo vídeo sempre resolvem para as três chaves determinísticas especificadas.
- Uma presigned GET com `Range: bytes=0-1023` recebe `206` do MinIO com `Content-Range`, `Accept-Ranges` e 1024 bytes.
- Nenhuma operação de upload/download de vídeo exige materializar o arquivo completo em memória.

---

### SI-03.4 — Publicar outbox na fila de processamento

**Description:** Entregar de forma recuperável os eventos persistidos ao BullMQ, aceitando at-least-once sem perder trabalho entre PostgreSQL e Redis.

**Technical actions:**

1. Criar contratos compartilhados `VIDEO_PROCESSING_QUEUE`, `PROCESS_VIDEO_JOB` e `ProcessVideoJob`, e configurar `BullModule.forRootAsync()`/`registerQueue()` com `queueConfig` (per `phase-03-videos/TD-03`).
2. Criar `VideoProcessingOutboxRepository` com claim paginado em transação curta e `FOR UPDATE SKIP LOCKED`, filtrando `published_at IS NULL` e `available_at <= now()` conforme `### Data Model`.
3. Implementar `VideoProcessingOutboxRelay` com loop não sobreposto e cancelável, publicando `video.processing.requested` com `jobId = video-processing-{eventId}`, três tentativas, backoff exponencial e retenção limitada (per `phase-03-videos/TD-05`).
4. Marcar `published_at` após sucesso; em falha incrementar `attempts`, sanitizar `last_error` e reagendar `available_at`, mantendo o evento recuperável e logs com `eventId`/`videoId`.
5. Criar `VideoProcessingQueueModule` com providers/exports mínimos, lifecycle de startup/shutdown e fechamento das conexões BullMQ sem duplicar providers entre API e worker.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingOutboxRepository` | Integration: claim concorrente, ordenação e reentrega | `src/videos/processing/video-processing-outbox.repository.integration-spec.ts` |
| `VideoProcessingOutboxRelay` | Unit: sucesso, falha, backoff e encerramento com queue mockada | `src/videos/processing/video-processing-outbox-relay.spec.ts` |
| Publicação BullMQ | Integration: outbox real + Redis real + job tipado/deduplicado | `src/videos/processing/video-processing-queue.integration-spec.ts` |
| `VideoProcessingQueueModule` | Unit: compilação DI com BullMQ configurado | `src/videos/processing/video-processing-queue.module.spec.ts` |

**Dependencies:** SI-03.1 — Redis/config; SI-03.2 — entidade outbox

**Acceptance criteria:**

- Um outbox elegível produz um job `video.processing.requested` contendo `version`, `eventId` e `videoId`, e recebe `published_at` somente após a fila aceitar o job.
- Redis indisponível mantém o outbox não publicado, incrementa `attempts` e permite nova tentativa após `available_at`.
- Dois relays concorrentes não processam simultaneamente a mesma linha de outbox.
- Republicar o mesmo `eventId` não cria trabalho funcional duplicado e permanece seguro mesmo se a retenção do job anterior tiver expirado.

---

### SI-03.5 — Implementar lifecycle multipart de vídeo

**Description:** Orquestrar criação do rascunho, retomada, assinatura de partes, conclusão idempotente e aborto sem transportar bytes pela API.

**Technical actions:**

1. Criar `VideoRepository`/`VideoOwnershipService` para consultas por UUID ou `public_id` com ownership via `Channel.user_id`, e exceções do `### Error Catalog` sem vazar existência entre donos.
2. Criar `PublicVideoIdService` com `nanoid()` default de 21 caracteres e retry limitado exclusivamente para violação `23505` em `public_id` (per `phase-03-videos/TD-09`).
3. Implementar `VideoUploadService.initiate`, `resume` e `signParts` conforme os três primeiros blocos de `### API Contracts`, persistindo rascunho/sessão antes de retornar e delegando todo controle de bytes ao `ObjectStoragePort` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-06`).
4. Implementar `complete` com `ListParts` autoritativo, `CompleteMultipartUpload` e transação PostgreSQL que atualiza upload/vídeo e insere um único outbox; reconciliar retry após storage concluído via estado persistido/`HeadObject` (per `phase-03-videos/TD-05`).
5. Implementar `abort` idempotente e guardas centralizadas de sessão ativa/expirada, tamanho, content type, ETags e transições; propagar erros tipados para o filtro global.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `PublicVideoIdService` | Unit: tamanho/alfabeto e retry apenas para colisão de `public_id` | `src/videos/public-video-id.service.spec.ts` |
| `VideoUploadService` | Unit: ownership, lifecycle, validação de partes e ramos idempotentes com ports mockados | `src/videos/video-upload.service.spec.ts` |
| `VideoUploadService` | Integration: transações, MinIO real e outbox PostgreSQL | `src/videos/video-upload.service.integration-spec.ts` |

**Dependencies:** SI-03.2 — modelo persistente; SI-03.3 — storage port; SI-03.4 — contrato da fila/outbox

**Acceptance criteria:**

- Iniciar upload válido persiste um `Video` `draft` e um `VideoUpload` `initiated` antes de retornar IDs, `part_size` e `expires_at`.
- Retomar uma sessão retorna as partes realmente presentes no MinIO, ordenadas por `part_number`.
- Solicitar partes válidas retorna somente URLs de `UploadPart` para o bucket/key/upload do vídeo dono.
- Completar todas as partes move exatamente um vídeo para `processing` e cria exatamente um evento `video.processing.requested`.
- Repetir a conclusão após sucesso retorna o mesmo estado e não cria outro vídeo nem outro outbox.
- Abortar duas vezes uma sessão ativa termina com status `aborted` sem erro adicional; tentar abortar uma concluída produz `UPLOAD_ALREADY_COMPLETED`.
- Uma colisão de `public_id` é regenerada, enquanto qualquer outra falha PostgreSQL é propagada sem retry indevido.

---

### SI-03.6 — Limpar uploads multipart expirados

**Description:** Encerrar sessões abandonadas e liberar partes órfãs sem interferir em uploads ainda retomáveis.

**Technical actions:**

1. Criar consulta paginada em `VideoUploadRepository` para reclamar sessões `initiated` com `expires_at <= now()`, usando lock concorrente e sem selecionar uploads ativos.
2. Implementar `VideoUploadCleanupService` com loop não sobreposto/cancelável que chama `AbortMultipartUpload` e somente depois persiste `status = aborted` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-06`).
3. Em falha transitória de storage, manter a sessão elegível, registrar IDs/categoria do erro e aplicar backoff, sem marcar limpeza inexistente como concluída.
4. Registrar o cleanup apenas no runtime API, integrar com shutdown hooks e expor configuração de intervalo/batch sem adicionar scheduler externo.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoUploadCleanupService` | Unit: elegibilidade, sucesso, falha/backoff e shutdown | `src/videos/video-upload-cleanup.service.spec.ts` |
| Cleanup multipart | Integration: PostgreSQL + MinIO real, concorrência e remoção de partes | `src/videos/video-upload-cleanup.service.integration-spec.ts` |

**Dependencies:** SI-03.2 — sessões persistidas; SI-03.3 — abort multipart; SI-03.5 — lifecycle compartilhado

**Acceptance criteria:**

- Uma sessão `initiated` expirada é abortada no MinIO e termina persistida como `aborted`.
- Uma sessão cujo `expires_at` ainda está no futuro permanece disponível para retomada.
- Dois processos de cleanup concorrentes não abortam simultaneamente a mesma sessão.
- MinIO indisponível preserva a sessão para nova tentativa e não relata falsamente status `aborted`.

---

### SI-03.7 — Expor endpoints de upload multipart

**Description:** Conectar o lifecycle multipart ao HTTP autenticado com DTOs estritos, controllers finos e documentação OpenAPI explícita.

**Route:** POST `/videos/uploads`; GET `/videos/:videoId/uploads/:uploadId`; POST `/videos/:videoId/uploads/:uploadId/parts`; POST `/videos/:videoId/uploads/:uploadId/complete`; DELETE `/videos/:videoId/uploads/:uploadId`
**Test Specs:** see `nestjs-project/specs/videos-uploads.plan.md`
**Authorization:** somente o dono do canal/vídeo, conforme `### Authorization Matrix`

**Technical actions:**

1. Criar DTOs de params/body para iniciação, assinatura de partes e conclusão, preservando byte-verbatim `title`, `file_size`, `content_type`, `part_numbers`, `parts`, `part_number` e `etag` de `### API Contracts` (per `phase-03-videos/TD-01`).
2. Criar response DTOs para os status `201`, `200` e `202`, sem serializar `channel_id`, chaves internas, credenciais ou metadata de fila/storage.
3. Implementar `VideosController` com os cinco endpoints multipart, `JwtAuthGuard` global/`CurrentUser`, status codes corretos e delegação integral ao `VideoUploadService`.
4. Adicionar `@ApiTags`, `@ApiBearerAuth`, `@ApiOperation` e respostas tipadas por status/error envelope; DTO inference usa o CLI plugin, operações/erros permanecem explícitos (per `openapi-docs-nestjs/TD-01`).
5. Registrar controller e providers no `VideosModule`, importar `StorageModule`, `VideoProcessingQueueModule` e `ChannelsModule` sem duplicar providers, exportando apenas serviços requeridos por runtimes posteriores.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosModule` | Unit: compilação DI com TypeORM, storage e BullMQ configurados | `src/videos/videos.module.spec.ts` |

Os cenários HTTP/DTO/authorization são externalizados pelo campo `Test Specs`; nenhum teste unitário de controller é criado.

**Dependencies:** SI-03.5 — serviço multipart; SI-03.6 — lifecycle/cleanup compartilhado

**Acceptance criteria:**

- `POST /videos/uploads` com payload válido retorna `201` com `video_id`, `public_id`, `upload_id`, `part_size`, `status` e `expires_at`.
- `GET /videos/:videoId/uploads/:uploadId` pelo dono retorna `200` com sessão e `uploaded_parts` autoritativos.
- `POST /videos/:videoId/uploads/:uploadId/parts` com partes distintas retorna `200` com uma URL expirada por `part_number` solicitado.
- `POST /videos/:videoId/uploads/:uploadId/complete` com a lista confirmada retorna `202` e `status: processing`.
- `DELETE /videos/:videoId/uploads/:uploadId` para sessão ativa retorna `204` sem corpo.
- Payload ou params inválidos retornam `400` com `{ statusCode: 400, error: "VALIDATION_ERROR", message }`.
- Ausência de token retorna `401`; usuário autenticado não dono retorna `403` com `error: "VIDEO_ACCESS_DENIED"` antes de qualquer operação no storage.

---

### SI-03.8 — Processar vídeos no worker isolado

**Description:** Consumir jobs no processo `video-worker`, produzir MP4/thumbnail/metadados com FFmpeg e persistir transições idempotentes sem bloquear a API.

**Technical actions:**

1. Definir `MediaProcessorPort` e implementar `FfmpegMediaProcessor` com `spawn`/argument array, timeout configurado, captura limitada de stderr e cleanup garantido de diretório temporário (per `phase-03-videos/TD-04`).
2. Implementar pipeline stream-to-file que baixa `source_object_key`, executa `ffprobe` e normaliza `duration_seconds`/`metadata` exatamente como `### Data Model`, sem carregar o vídeo completo em memória.
3. Executar FFmpeg para gerar MP4 H.264/AAC `yuv420p` + `+faststart` e JPEG, enviar ambos às chaves determinísticas e validar a existência dos artefatos (per `phase-03-videos/TD-07`).
4. Criar `VideoProcessingService` e `VideoProcessor extends WorkerHost`: short-circuit para `ready`, `processing` durante retries, transação final para `ready`, e `error`/`processing_error` apenas na última tentativa; sempre rethrow para semântica BullMQ (per `phase-03-videos/TD-05`).
5. Criar `VideoWorkerModule` e `src/video-worker.ts` com application context sem HTTP, concorrência default `1`, shutdown hooks e fechamento gracioso de worker, Redis, DB, S3 e processo FFmpeg (per `phase-03-videos/TD-03`, `phase-03-videos/TD-04`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `FfmpegMediaProcessor` | Unit: argumentos, timeout, erro de processo e cleanup | `src/videos/processing/ffmpeg-media-processor.spec.ts` |
| Pipeline FFmpeg | Integration: fixture curta gera MP4 probeável + JPEG e metadata normalizada | `src/videos/processing/ffmpeg-media-processor.integration-spec.ts` |
| `VideoProcessingService` | Unit: idempotência, transições e ramos retry/final failure | `src/videos/processing/video-processing.service.spec.ts` |
| `VideoProcessor` | Integration: BullMQ + Redis + PostgreSQL + MinIO + FFmpeg reais | `src/videos/processing/video-processor.integration-spec.ts` |
| `VideoWorkerModule` | Unit: compilação DI do application context sem controller HTTP | `src/videos/processing/video-worker.module.spec.ts` |

**Dependencies:** SI-03.3 — I/O de objetos; SI-03.4 — fila tipada; SI-03.5 — lifecycle `processing`

**Acceptance criteria:**

- Um job válido para source completa termina com `Video.status = ready`, duração/metadata preenchidas e duas chaves derivadas persistidas.
- O objeto playback resultante é um MP4 H.264/AAC reproduzível com `faststart`, e a thumbnail é um JPEG extraído do mesmo source.
- Reentregar um job cujo vídeo já está `ready` conclui sem criar outro vídeo nem novas chaves.
- Uma falha antes da última tentativa conserva `status = processing` e o job volta à fila com backoff.
- A última tentativa com falha deixa `status = error`, `processing_error` sanitizado e job BullMQ observável como failed.
- Encerrar `video-worker` durante processamento impede novos jobs e aguarda/encerra o trabalho corrente dentro do grace period configurado.

---

### SI-03.9 — Autorizar streaming e download por presigned URL

**Description:** Resolver vídeo pronto por `public_id`, aplicar a política owner-only desta fase e produzir redirects assinados sem proxy de bytes no NestJS.

**Technical actions:**

1. Criar `VideoDeliveryService` com lookup por `public_id`, ownership via `Channel.user_id` e gate `status = ready` + `playback_object_key`, emitindo `VIDEO_NOT_FOUND`, `VIDEO_ACCESS_DENIED` e `VIDEO_NOT_READY` conforme o catálogo (per `phase-03-videos/TD-09`).
2. Implementar `createStreamRedirect` sobre `ObjectStoragePort`, assinando `GetObjectCommand` no endpoint público com TTL validado e preservando a entrega de `Range` no origin (per `phase-03-videos/TD-08`).
3. Implementar `createDownloadRedirect` para o mesmo artefato MP4 canônico, com override `Content-Disposition: attachment; filename="{public_id}.mp4"` seguro (per `phase-03-videos/TD-07`, `phase-03-videos/TD-08`).
4. Mapear indisponibilidade de assinatura para `STORAGE_UNAVAILABLE`, sem registrar URL assinada/credenciais e sem transformar falhas de authorization em storage calls.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoDeliveryService` | Unit: not found, non-owner, not ready, stream/download e falha de storage | `src/videos/video-delivery.service.spec.ts` |
| Entrega presigned | Integration: PostgreSQL + MinIO real, TTL, Range e content-disposition | `src/videos/video-delivery.service.integration-spec.ts` |

**Dependencies:** SI-03.2 — lookup/ownership; SI-03.3 — presigning; SI-03.8 — artefato playback pronto

**Acceptance criteria:**

- Um owner consulta um vídeo `ready` por `public_id` e recebe uma URL curta assinada para a chave playback persistida.
- A URL de streaming aceita `Range: bytes=0-1023` e o MinIO retorna `206` com headers parciais coerentes.
- A URL de download retorna o MP4 com disposition `attachment` e filename baseado somente em `public_id`.
- Vídeo inexistente retorna `VIDEO_NOT_FOUND`; vídeo não pronto retorna `VIDEO_NOT_READY`; non-owner retorna `VIDEO_ACCESS_DENIED`.
- Nenhuma resposta ou log expõe access key, secret, object key interno ou URL assinada após sua utilização.

---

### SI-03.10 — Expor redirects de streaming e download

**Description:** Publicar os contratos HTTP owner-only que redirecionam o cliente ao object storage e documentam explicitamente Range/206 e download.

**Route:** GET `/videos/:publicId/stream`; GET `/videos/:publicId/download`
**Test Specs:** see `nestjs-project/specs/videos-stream.plan.md`
**Authorization:** somente owner nesta fase; policy preparada para publicação anônima na Fase 04

**Technical actions:**

1. Criar `PublicVideoIdParamDto` com validação byte-verbatim do `publicId` de 21 caracteres e response/header contracts sem corpo para `307`.
2. Adicionar `stream` e `download` ao `VideosController`, delegando ao `VideoDeliveryService` e retornando redirect `307 Temporary Redirect`; não usar `@Res()` para implementar regra de negócio nem fazer pipe de bytes.
3. Documentar com Swagger o bearer auth, header `Range`, `Location`, erros tipados e o contrato do redirect target (`200`/`206`, `Accept-Ranges`, `Content-Range`, `Content-Length`) (per `openapi-docs-nestjs/TD-01`).
4. Regenerar `openapi.json` pelo script existente e manter os dois endpoints no `VideosModule`/`AppModule`, sem habilitar UI Swagger em produção (per `openapi-docs-nestjs/TD-02`, `openapi-docs-nestjs/TD-03`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Contratos OpenAPI de vídeo | Integration: paths, params, headers, status e error envelope exportados | `src/openapi-export.integration-spec.ts` |

Os cenários HTTP de redirect/authorization/Range são externalizados pelo campo `Test Specs`; nenhum teste unitário de controller é criado.

**Dependencies:** SI-03.7 — controller/módulo HTTP; SI-03.9 — serviço de entrega

**Acceptance criteria:**

- `GET /videos/:publicId/stream` pelo owner de vídeo pronto retorna `307`, header `Location` assinado e corpo vazio.
- Seguir o redirect de streaming com `Range: bytes=0-1023` resulta em `206` e exatamente 1024 bytes do MP4.
- `GET /videos/:publicId/download` pelo owner retorna `307` para URL cuja resposta é attachment `{public_id}.mp4`.
- Ausência de token retorna `401`; non-owner retorna `403` com `error: "VIDEO_ACCESS_DENIED"`; vídeo ainda processando retorna `409` com `error: "VIDEO_NOT_READY"`.
- O `openapi.json` exportado descreve request/response/error de todos os sete endpoints da fase sem placeholders genéricos.

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| `id` | uuid | PK, generated; preserves the relational identifier convention |
| `channel_id` | uuid | FK → `channels.id`, not null, `ON DELETE CASCADE` |
| `public_id` | varchar(21) | not null, unique; Nano ID generated with bounded retry on `23505` collision |
| `title` | varchar(255) | not null |
| `status` | enum (`draft`, `processing`, `ready`, `error`) | not null, default `draft` |
| `source_object_key` | text | not null; deterministic and independent of the client filename |
| `playback_object_key` | text | nullable until processing succeeds |
| `thumbnail_object_key` | text | nullable until processing succeeds |
| `duration_seconds` | numeric(12,3) | nullable, non-negative |
| `metadata` | jsonb | nullable; normalized `format`, `codec`, `width`, `height`, `bit_rate` and `size_bytes` produced by `ffprobe` |
| `processing_error` | text | nullable; diagnostic summary for the last terminal processing failure |
| `created_at` | timestamp | default `now()` |
| `updated_at` | timestamp | default `now()`, maintained by TypeORM |

**Relations:** `Channel` has many `Video`; `Video` belongs to one `Channel`. Add the inverse `videos` collection to `Channel`, without TypeORM save/remove cascade. Ownership is resolved through `channels.user_id` and never accepted from request input.

**Indexes:** unique on `public_id`; index on `channel_id`; composite index on (`channel_id`, `status`). The UUID remains the PK while `public_id` is the dedicated URL identifier, per `phase-03-videos/TD-09`.

#### VideoUpload

| Field | Type | Constraints |
|-------|------|-------------|
| `id` | uuid | PK, generated |
| `video_id` | uuid | FK → `videos.id`, not null, unique, `ON DELETE CASCADE` |
| `upload_id` | text | not null, unique; multipart identifier returned by object storage |
| `object_key` | text | not null; equals the owning video's `source_object_key` |
| `file_size` | bigint | not null, between 1 and 10,737,418,240 bytes |
| `content_type` | varchar(100) | not null, restricted to configured video media types |
| `part_size` | integer | not null; configured multipart chunk size, at least 5 MiB except the last part |
| `status` | enum (`initiated`, `completed`, `aborted`) | not null, default `initiated` |
| `expires_at` | timestamptz | not null; bounds resumability and orphan cleanup |
| `completed_at` | timestamptz | nullable |
| `created_at` | timestamp | default `now()` |
| `updated_at` | timestamp | default `now()`, maintained by TypeORM |

**Relations:** `VideoUpload` owns a one-to-one relation to `Video`. The persisted `upload_id`, `object_key`, part sizing and lifecycle are the resume contract selected by `phase-03-videos/TD-01` and `phase-03-videos/TD-06`; uploaded part numbers, ETags and sizes are re-read from S3-compatible storage with `ListParts` rather than duplicated in PostgreSQL.

**Indexes:** unique on `video_id`; unique on `upload_id`; index on (`status`, `expires_at`) for cleanup.

#### VideoProcessingOutbox

| Field | Type | Constraints |
|-------|------|-------------|
| `id` | uuid | PK, generated; also used as the event identifier |
| `video_id` | uuid | FK → `videos.id`, not null, `ON DELETE CASCADE` |
| `event_type` | varchar(100) | not null; `video.processing.requested` |
| `payload` | jsonb | not null; versioned message payload |
| `attempts` | integer | not null, default `0` |
| `available_at` | timestamptz | not null, default `now()` |
| `published_at` | timestamptz | nullable |
| `last_error` | text | nullable |
| `created_at` | timestamp | default `now()` |

**Relations:** `VideoProcessingOutbox` belongs to one `Video`. Multipart completion updates `Video.status` and inserts this row in the same PostgreSQL transaction; a relay later publishes it to BullMQ, closing the database/queue loss window per `phase-03-videos/TD-05`.

**Indexes:** unique on (`video_id`, `event_type`) to suppress duplicate processing requests; partial polling index on (`available_at`, `created_at`) where `published_at IS NULL`.

#### Storage key invariants

- Use one private bucket configured as `streamtube-media` locally; never derive keys from a user filename.
- Source: `videos/{videoId}/source/original`.
- Canonical playback artifact: `videos/{videoId}/playback/video.mp4`.
- Thumbnail: `videos/{videoId}/thumbnails/default.jpg`.
- Multipart retries and worker retries reuse these keys. A retry overwrites only deterministic derived outputs and never creates a second `Video`, per `phase-03-videos/TD-02`, `phase-03-videos/TD-05` and `phase-03-videos/TD-07`.
- The migration creates all three tables, enum types, foreign keys and named indexes in `up()` and reverses them in dependency order in `down()`.

### API Contracts

#### POST /videos/uploads (SI-03.5)

Starts a native S3-compatible multipart upload and creates the owning `Video` in `draft` status before media bytes are sent, per `phase-03-videos/TD-01` and `phase-03-videos/TD-06`.

**Request headers:**
- `Authorization: Bearer {access_token}`
- `Content-Type: application/json`

**Request body:**
- `title`: string, required, 1–255 characters after trim
- `file_size`: integer, required, 1–10,737,418,240 bytes
- `content_type`: string, required, one of `video/mp4`, `video/quicktime`, `video/x-matroska`, `video/webm`

**Response 201:**
- `video_id`: string (uuid)
- `public_id`: string (Nano ID, 21 characters)
- `upload_id`: string
- `part_size`: integer (bytes)
- `status`: `draft`
- `expires_at`: string (ISO-8601)

**Error responses:**
- 400 `VALIDATION_ERROR`: request shape or value is invalid
- 401 Unauthorized: access token is missing or invalid
- 403 `VIDEO_ACCESS_DENIED`: authenticated user has no channel ownership
- 413 `VIDEO_FILE_TOO_LARGE`: `file_size` exceeds 10GB
- 415 `UNSUPPORTED_VIDEO_TYPE`: `content_type` is outside the allowlist
- 503 `STORAGE_UNAVAILABLE`: multipart creation could not reach object storage

---

#### GET /videos/:videoId/uploads/:uploadId (SI-03.5)

Returns the persisted session plus the authoritative part list from object storage so a client can resume after interruption.

**Request headers:**
- `Authorization: Bearer {access_token}`

**Response 200:**
- `video_id`: string (uuid)
- `upload_id`: string
- `part_size`: integer (bytes)
- `file_size`: integer (bytes)
- `status`: `initiated` | `completed` | `aborted`
- `expires_at`: string (ISO-8601)
- `uploaded_parts`: array of `{ part_number: integer, etag: string, size: integer }`, ordered by `part_number`

**Error responses:**
- 401 Unauthorized: access token is missing or invalid
- 403 `VIDEO_ACCESS_DENIED`: video belongs to another channel
- 404 `UPLOAD_SESSION_NOT_FOUND`: video/session pair does not exist
- 410 `UPLOAD_SESSION_EXPIRED`: resumability window elapsed
- 503 `STORAGE_UNAVAILABLE`: uploaded parts could not be listed

---

#### POST /videos/:videoId/uploads/:uploadId/parts (SI-03.5)

Creates short-lived `UploadPart` presigned URLs; media bytes go directly from the client to MinIO/S3 and never traverse NestJS.

**Request headers:**
- `Authorization: Bearer {access_token}`
- `Content-Type: application/json`

**Request body:**
- `part_numbers`: array of 1–100 distinct integers, each between 1 and 10,000

**Response 200:**
- `parts`: array of `{ part_number: integer, upload_url: string, expires_at: string }`

**Error responses:**
- 400 `VALIDATION_ERROR`: part list is empty, duplicated, out of range or too large
- 401 Unauthorized: access token is missing or invalid
- 403 `VIDEO_ACCESS_DENIED`: video belongs to another channel
- 404 `UPLOAD_SESSION_NOT_FOUND`: video/session pair does not exist
- 409 `UPLOAD_SESSION_NOT_ACTIVE`: session is completed or aborted
- 410 `UPLOAD_SESSION_EXPIRED`: resumability window elapsed
- 503 `STORAGE_UNAVAILABLE`: URLs could not be signed

---

#### POST /videos/:videoId/uploads/:uploadId/complete (SI-03.5)

Verifies the submitted list against `ListParts`, completes the multipart object and atomically persists `processing` plus `video.processing.requested`. Repetition is idempotent: a completed object/session returns the existing processing state and cannot create a second outbox event.

**Request headers:**
- `Authorization: Bearer {access_token}`
- `Content-Type: application/json`

**Request body:**
- `parts`: non-empty array of `{ part_number: integer, etag: string }`, with distinct ascending part numbers

**Response 202:**
- `video_id`: string (uuid)
- `public_id`: string
- `status`: `processing`

**Error responses:**
- 400 `INVALID_UPLOAD_PARTS`: submitted parts differ from object storage or violate multipart ordering/sizing
- 401 Unauthorized: access token is missing or invalid
- 403 `VIDEO_ACCESS_DENIED`: video belongs to another channel
- 404 `UPLOAD_SESSION_NOT_FOUND`: video/session pair does not exist
- 409 `UPLOAD_SESSION_NOT_ACTIVE`: session was aborted
- 410 `UPLOAD_SESSION_EXPIRED`: resumability window elapsed
- 503 `STORAGE_UNAVAILABLE`: multipart completion could not be verified or completed

---

#### DELETE /videos/:videoId/uploads/:uploadId (SI-03.5)

Aborts an active multipart upload and marks its session `aborted`; repeated abort is a no-op.

**Request headers:**
- `Authorization: Bearer {access_token}`

**Response 204:** No content.

**Error responses:**
- 401 Unauthorized: access token is missing or invalid
- 403 `VIDEO_ACCESS_DENIED`: video belongs to another channel
- 404 `UPLOAD_SESSION_NOT_FOUND`: video/session pair does not exist
- 409 `UPLOAD_ALREADY_COMPLETED`: completed uploads cannot be aborted
- 503 `STORAGE_UNAVAILABLE`: multipart abort could not reach object storage

---

#### GET /videos/:publicId/stream (SI-03.7)

Authorizes the owner, signs the deterministic playback object and responds with a redirect so object storage serves the bytes, per `phase-03-videos/TD-08`.

**Request headers:**
- `Authorization: Bearer {access_token}`
- `Range: bytes={start}-{end}` (optional; preserved by the `307` redirect)

**Response 307:**
- `Location`: short-lived presigned GET URL for `videos/{videoId}/playback/video.mp4`
- No response body
- The redirect target must honor `Range`, respond `206 Partial Content` for satisfiable partial requests, and include `Accept-Ranges: bytes`, `Content-Range`, `Content-Length` and the playback `Content-Type`; a request without `Range` may receive `200 OK` from object storage.

**Error responses:**
- 401 Unauthorized: access token is missing or invalid
- 403 `VIDEO_ACCESS_DENIED`: video belongs to another channel
- 404 `VIDEO_NOT_FOUND`: `public_id` does not exist
- 409 `VIDEO_NOT_READY`: status is not `ready` or no playback key exists
- 503 `STORAGE_UNAVAILABLE`: playback URL could not be signed

---

#### GET /videos/:publicId/download (SI-03.7)

Authorizes the owner and redirects to a short-lived presigned GET URL for the canonical playback artifact with an attachment disposition.

**Request headers:**
- `Authorization: Bearer {access_token}`

**Response 307:**
- `Location`: presigned GET URL with `response-content-disposition=attachment; filename="{public_id}.mp4"`
- No response body; object storage serves the file

**Error responses:**
- 401 Unauthorized: access token is missing or invalid
- 403 `VIDEO_ACCESS_DENIED`: video belongs to another channel
- 404 `VIDEO_NOT_FOUND`: `public_id` does not exist
- 409 `VIDEO_NOT_READY`: status is not `ready` or no playback key exists
- 503 `STORAGE_UNAVAILABLE`: download URL could not be signed

---

#### Validation Rules — upload and delivery

- Route parameters `videoId` must be UUIDs; `publicId` must match the configured 21-character Nano ID alphabet; `uploadId` must be non-empty and length-bounded before storage calls.
- Multipart completion rejects duplicate, missing, unordered or non-positive part numbers and ETags that are empty after trim; server-side `ListParts` is authoritative.
- `file_size` is validated before `CreateMultipartUpload`; object metadata also records the declared size/content type for audit, while FFprobe remains authoritative for the actual media.
- Never accept `channel_id`, object keys, status, output keys or processing metadata from an HTTP body.
- Controllers remain transport-only, apply explicit Swagger operation/response decorators and delegate ownership, lifecycle and side effects to focused services.

### Authorization Matrix

| Endpoint | Anonymous | Authenticated non-owner | Owner |
|----------|-----------|-------------------------|-------|
| POST `/videos/uploads` | ✗ | ✗ | ✓, using the channel tied to JWT `sub` |
| GET `/videos/:videoId/uploads/:uploadId` | ✗ | ✗ | ✓ |
| POST `/videos/:videoId/uploads/:uploadId/parts` | ✗ | ✗ | ✓ |
| POST `/videos/:videoId/uploads/:uploadId/complete` | ✗ | ✗ | ✓ |
| DELETE `/videos/:videoId/uploads/:uploadId` | ✗ | ✗ | ✓ |
| GET `/videos/:publicId/stream` | ✗ | ✗ | ✓ when `status = ready` |
| GET `/videos/:publicId/download` | ✗ | ✗ | ✓ when `status = ready` |

Phase 03 exposes backend-only draft/processing capabilities. Anonymous playback and published-video visibility remain a Phase 04 policy extension; this phase keeps the delivery service policy isolated so public access can be added without changing storage keys or byte delivery.

### Error Catalog

All domain and validation failures use the inherited envelope `{ statusCode, error, message }` from `phase-02-auth/TD-07`. `error` is the machine-readable field; it must not be renamed to `errorCode` or `code`. Validation failures retain `error: VALIDATION_ERROR` and an array-valued `message`; unexpected implementation details, object keys, presigned URLs and FFmpeg stderr are never returned to clients.

| `error` | HTTP | Trigger |
|---------|------|---------|
| `VIDEO_NOT_FOUND` | 404 | Requested `video_id` or `public_id` does not exist |
| `VIDEO_ACCESS_DENIED` | 403 | Authenticated user does not own the video's channel, or has no channel for upload creation |
| `VIDEO_FILE_TOO_LARGE` | 413 | Declared upload size exceeds 10,737,418,240 bytes |
| `UNSUPPORTED_VIDEO_TYPE` | 415 | Declared content type is not in the configured video allowlist |
| `UPLOAD_SESSION_NOT_FOUND` | 404 | `videoId` and `uploadId` do not identify the same persisted session |
| `UPLOAD_SESSION_EXPIRED` | 410 | Multipart session passed `expires_at` |
| `UPLOAD_SESSION_NOT_ACTIVE` | 409 | Part signing/completion targets a completed or aborted session |
| `UPLOAD_ALREADY_COMPLETED` | 409 | Abort targets an upload already finalized |
| `INVALID_UPLOAD_PARTS` | 400 | Submitted part list differs from `ListParts` or violates multipart invariants |
| `VIDEO_NOT_READY` | 409 | Streaming/download requested before the canonical playback object is ready |
| `STORAGE_UNAVAILABLE` | 503 | Required S3-compatible operation or presigning fails after boundary-level handling |

Worker failures do not create an HTTP-only exception: retryable errors are rethrown to BullMQ; after the final configured attempt the worker persists `Video.status = error` and a sanitized `processing_error`. Logs retain the correlation fields `eventId`, `jobId` and `videoId`.

### Events/Messages

#### video.processing.requested

**Payload:**

```json
{
  "version": 1,
  "eventId": "uuid",
  "videoId": "uuid"
}
```

**Producer:** `VideoProcessingOutboxRelay` publishes the persisted `VideoProcessingOutbox` row to the `video-processing` BullMQ queue after multipart completion (per `phase-03-videos/TD-03` and `phase-03-videos/TD-05`).

**Consumer:** `VideoProcessor` in the standalone `VideoWorkerModule` process/container (per `phase-03-videos/TD-04`).

**Trigger:** `CompleteMultipartUpload` has succeeded and the same database transaction has moved the video from `draft` to `processing` and inserted the outbox event.

**Delivery semantics:** at-least-once. BullMQ `jobId` is deterministically `video-processing-{eventId}`; duplicate publication is accepted by the producer and duplicate consumption is safe through persisted lifecycle checks and deterministic output keys. Configure three attempts with exponential backoff, retain terminal failed jobs for diagnosis, and remove completed jobs with a bounded retention count.

**Relay semantics:** claim unpublished rows in short PostgreSQL transactions using `FOR UPDATE SKIP LOCKED`; publish outside the lock-holding transaction; then set `published_at`. On publish failure increment `attempts`, set `last_error`, advance `available_at` with bounded backoff and rethrow/log. A crash after queue publication but before `published_at` only republishes the same deterministic `jobId`.

**Processor contract:**

1. Load the `Video` by `videoId`; return success immediately when it is already `ready` and both deterministic derived keys are persisted.
2. Use a per-job temporary directory, fetch `source_object_key` from storage, and never load the complete media file into a NestJS HTTP request or memory buffer.
3. Run `ffprobe` to produce duration and normalized technical metadata; invoke FFmpeg through a dedicated adapter using an argument array (never shell interpolation) to create an H.264/AAC MP4 with `yuv420p` and `+faststart`, plus one JPEG thumbnail. This is the canonical playback artifact selected by `phase-03-videos/TD-07`; HLS renditions remain out of scope.
4. Upload playback and thumbnail to their deterministic keys, then atomically persist `duration_seconds`, `metadata`, both derived keys, clear `processing_error`, and set `status = ready`.
5. On retryable failure, leave `status = processing`, clean local temp files and rethrow. On the final BullMQ attempt, persist `status = error` and a sanitized `processing_error`, then rethrow so the failed job remains observable.
6. Worker shutdown stops accepting new jobs, waits for the current job within a configured grace period, closes BullMQ/Redis, TypeORM and storage clients, and removes temporary files.

The API and worker share the same `nestjs-project` source tree, domain entities and providers, but use separate Nest bootstrap entrypoints and Docker Compose services. The worker is not a second repository or independent project.

---

## Dependency Map

SI-03.1 (root — dependências, config e Compose)
├── SI-03.2 — depends on SI-03.1 (schema/módulo usa a fundação configurada)
├── SI-03.3 — depends on SI-03.1 (adapter requer MinIO e config)
└── SI-03.4 — depends on SI-03.1 + SI-03.2 (Redis/config + outbox)
SI-03.2 + SI-03.3 + SI-03.4
└── SI-03.5 — multipart lifecycle e outbox transacional
    ├── SI-03.6 — depends on SI-03.2 + SI-03.3 + SI-03.5 (cleanup expirado)
    │   └── SI-03.7 — depends on SI-03.5 + SI-03.6 (HTTP upload)
    └── SI-03.8 — depends on SI-03.3 + SI-03.4 + SI-03.5 (worker)
        └── SI-03.9 — depends on SI-03.2 + SI-03.3 + SI-03.8 (delivery service)
SI-03.7 + SI-03.9
└── SI-03.10 — redirects HTTP de streaming/download

---

## Deliverables

- [ ] SI-03.1 — Provisionar infraestrutura de mídia e fila
- [ ] SI-03.2 — Persistir vídeos, uploads e outbox
- [ ] SI-03.3 — Implementar boundary S3-compatible
- [ ] SI-03.4 — Publicar outbox na fila de processamento
- [ ] SI-03.5 — Implementar lifecycle multipart de vídeo
- [ ] SI-03.6 — Limpar uploads multipart expirados
- [ ] SI-03.7 — Expor endpoints de upload multipart
- [ ] SI-03.8 — Processar vídeos no worker isolado
- [ ] SI-03.9 — Autorizar streaming e download por presigned URL
- [ ] SI-03.10 — Expor redirects de streaming e download
- [ ] `openapi.json` regenerado pelo script e consistente com os sete endpoints de vídeo
- [ ] `db`, `minio` e `redis` saudáveis; `nestjs-api` e `video-worker` iniciando como serviços distintos no Compose

**Full test suites:**

- [ ] Backend unit + integration tests pass (`docker compose -f nestjs-project/compose.yaml exec nestjs-api npm test`)
- [ ] Serialized integration tests pass (`docker compose -f nestjs-project/compose.yaml exec nestjs-api npm run test:integration`)
- [ ] Backend E2E tests pass (`docker compose -f nestjs-project/compose.yaml exec nestjs-api npm run test:e2e`)
- [ ] TypeScript compiles cleanly (`docker compose -f nestjs-project/compose.yaml exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes without mutating files (`docker compose -f nestjs-project/compose.yaml exec nestjs-api npm run lint -- --no-fix`)
- [ ] Project builds successfully (`docker compose -f nestjs-project/compose.yaml exec nestjs-api npm run build`)
