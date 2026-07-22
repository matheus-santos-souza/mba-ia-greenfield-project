---
paths:
  - 'nestjs-project/**/*.dto.ts'
description: 'DTO conventions for input validation and data transfer'
---

# DTO Rules

## Validation

- Always use `class-validator` decorators on every field (`@IsString()`, `@IsEmail()`, `@IsNotEmpty()`, etc.)
- Apply `class-transformer` decorators when type coercion is needed (e.g., `@Type(() => Number)`)

## OpenAPI Documentation

DTOs are the source of request/response schemas in the exported `openapi.json`. Field-level documentation is the DTO's responsibility — controllers document operations (status codes, summaries), not schemas.

### Exported schemas require explicit Swagger metadata

Although `nest-cli.json` configures the `@nestjs/swagger` CLI plugin, `npm run openapi:export` executes `src/openapi-export.ts` through `ts-node`. That path does not apply the Nest CLI compile-time transformer. A DTO that relies only on `class-validator` metadata exports as an empty `properties: {}` schema.

Every request and response DTO referenced by a controller must therefore annotate its fields explicitly with `@ApiProperty()` or `@ApiPropertyOptional()`. Keep Swagger constraints synchronized with `class-validator`; changing validation and OpenAPI metadata is one atomic contract change.

For nested arrays, provide the element type explicitly. For enums, formats, nullable fields, and constrained identifiers, declare the corresponding schema metadata:

```typescript
export class InitiateVideoUploadDto {
  @ApiProperty({ minLength: 1, maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title: string;

  @ApiProperty({ type: 'integer', minimum: 1 })
  @IsInt()
  @Min(1)
  file_size: number;

  @ApiProperty({ maxLength: 100, example: 'video/mp4' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  content_type: string;
}
```

The exported `openapi.json` is the verification target. When adding or changing a DTO, export the spec and assert the named schema has the expected non-empty properties, required fields, item schemas, and constraints. Do not accept a test that only checks that `components.schemas` is globally non-empty.

### Reuse the shared error envelope

The error envelope is a single DTO across the project (`ApiErrorEnvelope`), referenced from controllers via `getSchemaPath(ApiErrorEnvelope)`. Do not create per-module error DTOs — extend or reuse the envelope instead.

## Separation of Concerns

- Create separate DTOs per operation: `CreateXDto`, `UpdateXDto`, `QueryXDto`
- Never use an entity class as a DTO — entities are database models, DTOs are API contracts
- For update DTOs, use `PartialType(CreateXDto)` from `@nestjs/mapped-types` to avoid duplication

## Naming

- File naming: `create-user.dto.ts`, `update-video.dto.ts`, `query-channel.dto.ts`
- Class naming: `CreateUserDto`, `UpdateVideoDto`, `QueryChannelDto`
