import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportSpec } from './openapi-export';

describe('exportSpec (integration)', () => {
  let outputPath: string;
  let document: Record<string, unknown>;

  beforeAll(async () => {
    outputPath = join(tmpdir(), `openapi-test-${Date.now()}.json`);
    await exportSpec(outputPath);
    document = JSON.parse(readFileSync(outputPath, 'utf-8')) as Record<
      string,
      unknown
    >;
  }, 30_000);

  it('exports a valid OpenAPI 3.x document', () => {
    expect(document.openapi).toMatch(/^3\./);
  });

  it('sets info.title to "StreamTube API"', () => {
    const info = document.info as Record<string, unknown>;
    expect(info.title).toBe('StreamTube API');
  });

  it('sets info.version to "1.0"', () => {
    const info = document.info as Record<string, unknown>;
    expect(info.version).toBe('1.0');
  });

  it('includes access-token Bearer security scheme', () => {
    const components = document.components as Record<string, unknown>;
    const schemes = components.securitySchemes as Record<
      string,
      Record<string, unknown>
    >;
    expect(schemes['access-token']).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
  });

  it('includes non-empty components.schemas from DTO inference', () => {
    const components = document.components as Record<string, unknown>;
    const schemas = components.schemas as Record<string, unknown>;
    expect(Object.keys(schemas).length).toBeGreaterThan(0);
  });

  it('includes ApiErrorEnvelope schema with expected properties', () => {
    const components = document.components as Record<string, unknown>;
    const schemas = components.schemas as Record<
      string,
      Record<string, unknown>
    >;
    expect(schemas['ApiErrorEnvelope']).toBeDefined();
    const props = schemas['ApiErrorEnvelope'].properties as Record<
      string,
      unknown
    >;
    expect(props).toHaveProperty('statusCode');
    expect(props).toHaveProperty('error');
    expect(props).toHaveProperty('message');
    expect(props).toHaveProperty('code');
  });

  it('has at least one path with a 401 response referencing ApiErrorEnvelope', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const apiErrorRef = '#/components/schemas/ApiErrorEnvelope';

    const hasRef = Object.values(paths).some((methods) =>
      Object.values(methods).some((operation) => {
        const responses = operation.responses as Record<
          string,
          Record<string, unknown>
        >;
        const r401 = responses?.['401'];
        if (!r401) return false;
        const content = r401.content as Record<string, Record<string, unknown>>;
        const jsonContent = content?.['application/json'];
        const schema = jsonContent?.schema as Record<string, unknown>;
        return schema?.['$ref'] === apiErrorRef;
      }),
    );

    expect(hasRef).toBe(true);
  });

  it('protected auth endpoints include access-token security requirement', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const protectedPaths = [
      { path: '/auth/logout', method: 'post' },
      { path: '/auth/me', method: 'get' },
    ];

    for (const { path, method } of protectedPaths) {
      const operation = paths[path]?.[method];
      expect(operation).toBeDefined();
      const security = operation?.security as Array<Record<string, unknown>>;
      expect(security).toBeDefined();
      expect(security.some((req) => 'access-token' in req)).toBe(true);
    }
  });

  it('all auth endpoints have a non-empty summary', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const authPaths = Object.entries(paths).filter(([p]) =>
      p.startsWith('/auth/'),
    );

    expect(authPaths.length).toBeGreaterThan(0);

    for (const [, methods] of authPaths) {
      for (const operation of Object.values(methods)) {
        expect(typeof operation.summary).toBe('string');
        expect((operation.summary as string).length).toBeGreaterThan(0);
      }
    }
  });

  it('exports exactly the seven phase video operations', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const expectedOperations = [
      'post /videos/uploads',
      'get /videos/{videoId}/uploads/{uploadId}',
      'post /videos/{videoId}/uploads/{uploadId}/parts',
      'post /videos/{videoId}/uploads/{uploadId}/complete',
      'delete /videos/{videoId}/uploads/{uploadId}',
      'get /videos/{publicId}/stream',
      'get /videos/{publicId}/download',
    ];
    const videoOperations = Object.entries(paths)
      .filter(([path]) => path.startsWith('/videos'))
      .flatMap(([path, methods]) =>
        Object.keys(methods).map((method) => `${method} ${path}`),
      );

    expect(videoOperations.sort()).toEqual(expectedOperations.sort());
  });

  it('documents the stream redirect, byte ranges and redirect target responses', () => {
    const operation = getOperation(
      document,
      '/videos/{publicId}/stream',
      'get',
    );
    const parameters = operation.parameters as Array<Record<string, unknown>>;
    const publicId = parameters.find(
      (parameter) => parameter.name === 'publicId',
    );
    const range = parameters.find((parameter) => parameter.name === 'Range');
    const responses = operation.responses as Record<
      string,
      Record<string, unknown>
    >;
    const redirect = responses['307'];
    const redirectHeaders = redirect.headers as Record<
      string,
      Record<string, unknown>
    >;
    const target = operation['x-redirect-target'] as Record<string, unknown>;
    const targetResponses = target.responses as Record<
      string,
      Record<string, unknown>
    >;
    const partialHeaders = targetResponses['206'].headers as Record<
      string,
      unknown
    >;

    expect(operation.security).toContainEqual({ 'access-token': [] });
    expect(publicId).toMatchObject({
      in: 'path',
      required: true,
      schema: {
        type: 'string',
        minLength: 21,
        maxLength: 21,
        pattern: '^[A-Za-z0-9_-]{21}$',
      },
    });
    expect(range).toMatchObject({
      in: 'header',
      required: false,
      schema: { type: 'string', pattern: '^bytes=\\d*-\\d*$' },
    });
    expect(redirect).not.toHaveProperty('content');
    expect(redirectHeaders.Location).toMatchObject({
      schema: { type: 'string', format: 'uri' },
    });
    expect(Object.keys(targetResponses).sort()).toEqual(['200', '206']);
    expect(partialHeaders).toEqual(
      expect.objectContaining({
        'Accept-Ranges': expect.any(Object),
        'Content-Range': expect.any(Object),
        'Content-Length': expect.any(Object),
        'Content-Type': expect.any(Object),
      }),
    );
    expectErrorEnvelopeResponses(responses);
  });

  it('documents the attachment download redirect without a response body', () => {
    const operation = getOperation(
      document,
      '/videos/{publicId}/download',
      'get',
    );
    const responses = operation.responses as Record<
      string,
      Record<string, unknown>
    >;
    const redirect = responses['307'];
    const target = operation['x-redirect-target'] as Record<string, unknown>;
    const targetResponses = target.responses as Record<
      string,
      Record<string, unknown>
    >;
    const targetHeaders = targetResponses['200'].headers as Record<
      string,
      unknown
    >;

    expect(operation.security).toContainEqual({ 'access-token': [] });
    expect(redirect).not.toHaveProperty('content');
    expect(targetHeaders).toHaveProperty('Content-Disposition');
    expectErrorEnvelopeResponses(responses);
  });
});

function getOperation(
  document: Record<string, unknown>,
  path: string,
  method: string,
): Record<string, unknown> {
  const paths = document.paths as Record<
    string,
    Record<string, Record<string, unknown>>
  >;
  const operation = paths[path]?.[method];
  expect(operation).toBeDefined();
  return operation;
}

function expectErrorEnvelopeResponses(
  responses: Record<string, Record<string, unknown>>,
): void {
  for (const status of ['400', '401', '403', '404', '409', '503']) {
    expect(responses[status]).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ApiErrorEnvelope' },
        },
      },
    });
  }
}
