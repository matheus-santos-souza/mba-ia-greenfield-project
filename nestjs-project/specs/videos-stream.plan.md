---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.10
target_file: test/videos-stream.e2e-spec.ts
---

# Redirects de streaming e download — Test Plan

## Application Overview

Os endpoints owner-only de entrega autorizam o acesso ao vídeo pronto e respondem com `307 Temporary Redirect` para URLs GET curtas e assinadas do artefato canônico no object storage. A API não faz proxy dos bytes: o redirect de streaming preserva `Range` para respostas parciais, enquanto o redirect de download força o nome público do arquivo como attachment.

## Test Scenarios

### 1. Entregar o artefato canônico por redirect assinado

**Setup:** bootstrap do `AppModule` real com a mesma configuração global de `main.ts`; `beforeEach` trunca PostgreSQL, limpa objetos de teste no MinIO e cria fixtures de owner, non-owner, tokens JWT e vídeo `ready` com playback MP4 conhecido; `afterAll` fecha a aplicação e conexões.

#### 1.1. redirecionar-stream-do-video-pronto

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-21T18:13:43Z

**Steps:**
  1. API caller envia `GET /videos/:publicId/stream` com token do owner para um vídeo `ready`
    - expect: a resposta tem status `307`
    - expect: o header `Location` contém uma URL GET curta e assinada para `videos/{videoId}/playback/video.mp4`
    - expect: o corpo da resposta está vazio e não expõe object key, credenciais ou metadata interna

#### 1.2. servir-range-parcial-no-destino-do-stream

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-21T18:13:43Z

**Steps:**
  1. API caller solicita `GET /videos/:publicId/stream` com token do owner e `Range: bytes=0-1023`
    - expect: a API responde `307` com `Location` assinado e corpo vazio
  2. API caller segue o `Location` preservando `Range: bytes=0-1023`
    - expect: o object storage responde `206 Partial Content`
    - expect: o body possui exatamente 1024 bytes do MP4 conhecido
    - expect: a resposta contém `Accept-Ranges: bytes`, `Content-Range`, `Content-Length: 1024` e o `Content-Type` de playback

#### 1.3. redirecionar-download-com-attachment-publico

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-21T18:13:43Z

**Steps:**
  1. API caller envia `GET /videos/:publicId/download` com token do owner para um vídeo `ready`
    - expect: a resposta tem status `307`, corpo vazio e header `Location` assinado
  2. API caller segue o `Location`
    - expect: o object storage serve o artefato canônico como attachment
    - expect: o `Content-Disposition` usa o filename `{public_id}.mp4` sem revelar o UUID ou a object key interna

#### 1.4. impor-autenticacao-ownership-e-readiness

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-21T18:13:43Z

**Steps:**
  1. API caller chama os endpoints de stream e download sem `Authorization`
    - expect: cada resposta tem status `401` e não contém `Location`
  2. API caller autenticado como non-owner chama os endpoints para o vídeo do owner
    - expect: cada resposta tem status `403` e `error: "VIDEO_ACCESS_DENIED"`
    - expect: nenhuma URL de storage é assinada
  3. API caller owner chama os endpoints para um vídeo em `processing`
    - expect: cada resposta tem status `409` e `error: "VIDEO_NOT_READY"`
    - expect: nenhuma URL de storage é assinada
