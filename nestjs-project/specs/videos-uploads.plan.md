---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: test/videos-uploads.e2e-spec.ts
---

# Endpoints de upload multipart — Test Plan

## Application Overview

Os endpoints autenticados de upload multipart criam o vídeo em rascunho, permitem retomar a sessão a partir do estado autoritativo do object storage, assinam partes para envio direto, concluem o objeto e abortam uploads ativos. O `VideosController` permanece transport-only e delega ownership, lifecycle, persistência e efeitos externos ao `VideoUploadService`; nenhum byte de mídia atravessa a API NestJS.

## Test Scenarios

### 1. Lifecycle multipart autenticado de vídeo

**Setup:** bootstrap do `AppModule` real com a mesma configuração global de `main.ts`; `beforeEach` trunca PostgreSQL em ordem segura, limpa uploads/objetos de teste no MinIO e filas BullMQ, e cria fixtures de owner, non-owner, canal e tokens JWT; `afterAll` fecha a aplicação e conexões.

#### 1.1. iniciar-upload-multipart

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-21T18:13:43Z

**Steps:**
  1. API caller envia `POST /videos/uploads` com token do owner e body válido contendo `title`, `file_size` e `content_type`
    - expect: a resposta tem status `201`
    - expect: o body contém somente o contrato público esperado, incluindo `video_id` UUID, `public_id` de 21 caracteres, `upload_id`, `part_size`, `status: "draft"` e `expires_at` ISO-8601
    - expect: o vídeo e a sessão multipart pertencem ao canal derivado do JWT, sem aceitar `channel_id`, object keys ou status enviados pelo cliente
    - expect: o multipart correspondente existe no object storage sem materializar o arquivo na memória da API

#### 1.2. retomar-upload-com-partes-autoritativas

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-21T18:13:43Z

**Steps:**
  1. API caller prepara uma sessão ativa do owner e envia ao object storage pelo menos uma parte válida
    - expect: a sessão permanece persistida como `initiated`
  2. API caller envia `GET /videos/:videoId/uploads/:uploadId` com o token do owner
    - expect: a resposta tem status `200`
    - expect: o body contém `video_id`, `upload_id`, `part_size`, `file_size`, `status`, `expires_at` e `uploaded_parts`
    - expect: `uploaded_parts` reflete a listagem autoritativa do object storage e está ordenado por `part_number`

#### 1.3. assinar-partes-distintas

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-21T18:13:43Z

**Steps:**
  1. API caller envia `POST /videos/:videoId/uploads/:uploadId/parts` com token do owner e `part_numbers` distintos dentro do intervalo permitido
    - expect: a resposta tem status `200`
    - expect: o body possui uma entrada por `part_number` solicitado, sem duplicatas, com `upload_url` e `expires_at`
    - expect: cada URL é curta, expira e aponta para a mesma sessão multipart sem expor credenciais de storage

#### 1.4. concluir-upload-e-iniciar-processamento

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-21T18:13:43Z

**Steps:**
  1. API caller prepara no object storage todas as partes declaradas para uma sessão ativa
    - expect: `ListParts` representa a lista autoritativa que será confirmada
  2. API caller envia `POST /videos/:videoId/uploads/:uploadId/complete` com token do owner e partes distintas em ordem ascendente
    - expect: a resposta tem status `202`
    - expect: o body contém `video_id`, `public_id` e `status: "processing"`
    - expect: a sessão fica `completed`, o vídeo fica `processing` e existe exatamente um evento outbox `video.processing.requested`

#### 1.5. abortar-upload-ativo

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-07-21T18:13:43Z

**Steps:**
  1. API caller envia `DELETE /videos/:videoId/uploads/:uploadId` para uma sessão ativa usando o token do owner
    - expect: a resposta tem status `204` e corpo vazio
    - expect: a sessão persistida fica `aborted` e o multipart deixa de estar ativo no object storage
  2. API caller repete o mesmo abort
    - expect: a operação é idempotente e não recria sessão, objeto nem evento de processamento

#### 1.6. rejeitar-payload-e-parametros-invalidos

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-07-21T18:13:43Z

**Steps:**
  1. API caller envia `POST /videos/uploads` com campo obrigatório ausente ou valor inválido
    - expect: a resposta tem status `400` e envelope `{ statusCode: 400, error: "VALIDATION_ERROR", message }`
    - expect: nenhum vídeo, sessão multipart ou objeto é criado
  2. API caller chama endpoints de sessão com `videoId` inválido, `uploadId` vazio/fora do limite, partes duplicadas ou fora do intervalo
    - expect: cada request inválida retorna `400` com o mesmo envelope de validação
    - expect: a rejeição ocorre antes de qualquer chamada ao object storage

#### 1.7. impor-autenticacao-e-ownership

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-07-21T18:13:43Z

**Steps:**
  1. API caller chama cada endpoint multipart sem `Authorization`
    - expect: cada resposta tem status `401`
    - expect: nenhuma sessão, objeto ou parte sofre alteração
  2. API caller autenticado como non-owner chama cada endpoint contra o vídeo/sessão do owner
    - expect: cada resposta tem status `403` e `error: "VIDEO_ACCESS_DENIED"`
    - expect: a verificação de ownership precede operações de criação, listagem, assinatura, conclusão ou abort no object storage
