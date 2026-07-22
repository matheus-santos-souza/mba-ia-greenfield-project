---
paths:
  - 'nestjs-project/**/*.entity.ts'
description: 'TypeORM entity conventions for database models'
---

# Entity Rules

## Naming and Structure

- Always pass an explicit table name to `@Entity('table_name')` — do not rely on auto-generated names
- Use UUID as primary key: `@PrimaryGeneratedColumn('uuid')`
- Mutable aggregate entities include both `@CreateDateColumn()` and `@UpdateDateColumn()`. Append-only/event records such as the processing outbox may omit `@UpdateDateColumn()` when their explicit lifecycle timestamps (`available_at`, `published_at`) are the real state contract.

## Column Conventions

- Sensitive fields (passwords, tokens) must use `{ select: false }` to exclude from default queries
- Give uniqueness and lookup indexes explicit stable names with `@Index`/`@Unique` when migrations and operational queries depend on them. Inline `{ unique: true }` is acceptable only when the generated constraint name is irrelevant.
- Define explicit column types when the default mapping is ambiguous
- Persist external identifiers, byte counts, TTL timestamps, status enums, JSON metadata, and nullable artifact keys with types that preserve their real range and nullability (`bigint` for declared video size, `timestamptz` for expiry/publication, `jsonb` for processing payload/metadata).

## Relationships

- Always define both sides of a relationship (e.g., `@OneToMany` + `@ManyToOne`)
- Prefer explicit relation loading (`relations: [...]`) — load only what each query needs
- Use eager loading only for low-cardinality, always-needed relations (e.g., `user.role`)
- Use lazy loading only when the relation is rarely accessed and the `Promise<>` type is acceptable

## Schema Changes

- Never modify an entity without creating a corresponding migration
- Never use `synchronize: true` in production — only in early development if at all
- Generate migrations via TypeORM CLI, review the SQL, and keep `synchronize: false` in application runtime configuration.
