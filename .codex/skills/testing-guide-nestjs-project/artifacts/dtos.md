> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# DTOs (`*.dto.ts`)

## What to test

DTOs define the shape and validation rules for API input using `class-validator` decorators. The testing goal is NOT to verify that individual decorators work (that's `class-validator`'s job) — it's to verify that **validation is wired correctly** at the HTTP layer.

- **Validation wiring** — `ValidationPipe` is active and rejects invalid input with 400
- **Whitelist enforcement** — unknown properties are stripped when `whitelist: true` is set
- **Security-critical validation** — if a DTO has business-critical rules (e.g., password strength, email format for registration), verify they reject at the HTTP layer
- **Transform behavior** — `class-transformer` decorators (`@Type()`, `@Transform()`) convert types correctly
- **OpenAPI schema export** — DTO fields, required arrays, nested items, enums, and constraints appear in `openapi.json` (the `ts-node` export path does not apply the Nest CLI plugin automatically)

## Layer assignment

| Scenario | Layer | Why |
|---|---|---|
| Standard DTO with class-validator decorators | **E2E** (one test per endpoint) | Proves validation is wired; don't test decorator behavior |
| DTO with security-critical validation | **E2E** (test the critical rules) | Security rules must be verified at the HTTP boundary |
| DTO with complex transform logic | **Unit** (rare) | Only if `@Transform()` contains non-trivial logic worth isolating |

DTOs do NOT get their own test files. Validation is tested as part of the controller's E2E tests.

OpenAPI metadata is the exception: `openapi-export.integration-spec.ts` must assert the relevant named schema has non-empty, correct properties. Do not rely on a global "schemas is non-empty" assertion.

## Setup pattern

DTO validation is tested within E2E tests (see `artifacts/controllers.md` for the full E2E setup):

```typescript
// Inside a controller E2E test file (e.g., test/users.e2e-spec.ts)

describe('POST /users — DTO validation', () => {
  it('should reject missing email with 400', () => {
    return request(app.getHttpServer())
      .post('/users')
      .send({ password: 'StrongPass1!' })
      .expect(400);
  });

  it('should reject invalid email format with 400', () => {
    return request(app.getHttpServer())
      .post('/users')
      .send({ email: 'not-an-email', password: 'StrongPass1!' })
      .expect(400);
  });

  it('should strip unknown properties (whitelist)', () => {
    return request(app.getHttpServer())
      .post('/users')
      .send({ email: 'new@test.com', password: 'StrongPass1!', isAdmin: true })
      .expect(201)
      .expect((res) => {
        expect(res.body).not.toHaveProperty('isAdmin');
      });
  });
});
```

**Key points:**
- DTO tests live in the E2E test file for the corresponding controller — not in a separate file
- One test sending a clearly invalid payload per endpoint is enough to prove the pipe is wired
- Do NOT write exhaustive tests for every `@IsString()`, `@IsNotEmpty()`, `@MaxLength()` — trust `class-validator`
- **Exception:** security-critical rules (password format, email uniqueness at validation level) deserve explicit tests
- Make sure `app.useGlobalPipes(new ValidationPipe({ whitelist: true }))` is applied in the E2E setup

## When to skip

- Do NOT create separate test files for DTOs (e.g., `create-user.dto.spec.ts`) — validation is an HTTP concern, tested at the E2E layer
- Do NOT test individual decorator behavior (`@IsEmail()` rejects "abc") — that's testing `class-validator`, not your code
- Skip `UpdateXDto` if it uses `PartialType(CreateXDto)` and `CreateXDto` validation is already tested

## Examples from project

- Auth DTOs are exercised by `auth.e2e-spec.ts` for validation, whitelist, and security-sensitive fields.
- `InitiateVideoUploadDto` rejects missing/invalid title, declared file size, unsupported media type, and non-whitelisted input.
- `SignVideoUploadPartsDto` enforces distinct integer part numbers within the request/S3 bounds.
- `CompleteVideoUploadDto` validates nested ETag entries and strictly ascending unique part numbers.
- Video response DTO schemas explicitly document UUID/public IDs, status enums, timestamps, presigned URI fields, and uploaded-part arrays.
