> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# Entities (`*.entity.ts`)

## What to test

- **Unique constraints** — inserting duplicate values on unique columns must throw
- **Not-null constraints** — inserting without required columns must throw
- **Default values** — `@CreateDateColumn()`, `@UpdateDateColumn()`, default column values populate correctly
- **`select: false` fields** — sensitive fields (passwords, tokens) are excluded from default `find` queries
- **Cascade behavior** — `cascade: true` on relations propagates saves/deletes as expected
- **Enum columns** — inserting invalid enum values is rejected by the database
- **Relation integrity** — foreign key constraints prevent orphaned records; `onDelete` behavior works
- **Column type mapping** — `jsonb`, `text[]`, and other non-trivial PostgreSQL types store/retrieve correctly

## Layer assignment

| Scenario | Layer | Why |
|---|---|---|
| Any entity with constraints, defaults, or `select: false` | **Integration** (real DB) | Constraints are enforced by PostgreSQL, not TypeORM — only a real DB proves they work |
| Entity with only basic columns, no constraints | **Skip** | Static field existence is not worth testing; TypeORM maps it automatically |

Entities are **never** tested at the unit layer — they have no logic, only structure that must be validated against the real database.

## Setup pattern

```typescript
// user.entity.integration-spec.ts
import { DataSource, Repository } from 'typeorm';
import { User } from './user.entity';
import { createTestDataSource } from '../test/create-test-data-source';

describe('User entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;

  beforeAll(async () => {
    dataSource = createTestDataSource([User]);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "users"');
  });

  it('should auto-generate uuid, createdAt, and updatedAt', async () => {
    const user = userRepository.create({ email: 'test@example.com', password: 'hashed' });
    const saved = await userRepository.save(user);

    expect(saved.id).toBeDefined();
    expect(saved.createdAt).toBeInstanceOf(Date);
    expect(saved.updatedAt).toBeInstanceOf(Date);
  });

  it('should enforce unique email constraint', async () => {
    await userRepository.save(
      userRepository.create({ email: 'dup@example.com', password: 'hashed' }),
    );

    await expect(
      userRepository.save(
        userRepository.create({ email: 'dup@example.com', password: 'other' }),
      ),
    ).rejects.toThrow(); // PostgreSQL unique violation
  });

  it('should exclude password from default select', async () => {
    await userRepository.save(
      userRepository.create({ email: 'test@example.com', password: 'secret' }),
    );

    const found = await userRepository.findOneBy({ email: 'test@example.com' });
    expect(found?.password).toBeUndefined();
  });
});
```

**Key points:**
- Use a real PostgreSQL connection (the Docker `db` service)
- Use `synchronize: true` in test setup to auto-create tables from entities
- Clean up with `dataSource.query('DELETE FROM "table"')` — not `repository.delete({})`
- Test constraints by attempting violations and expecting rejections
- Test `select: false` by querying without explicit select and asserting the field is absent

## When to skip

- Entities with only basic columns (`id`, `name`, `createdAt`) and no unique constraints, no `select: false`, no cascades — these are static structure that TypeORM maps automatically
- Do NOT test that a column exists or has a specific type — that's static structure assertion

## Examples from project

- **User / auth token entities** → unique email/token rules, hidden sensitive columns, expiry/revocation fields, and cascades.
- **Channel** → unique nickname, one-to-one ownership, and video cascade relation.
- **Video** → 21-character unique public ID, `draft|processing|ready|error`, nullable artifact/metadata fields, duration check, and channel cascade.
- **VideoUpload** → one session per video, unique S3 upload ID, 1..10 GiB size check, minimum part size, expiry, and `initiated|completed|aborted`.
- **VideoProcessingOutbox** → unique `(video_id,event_type)`, fixed event type, JSON payload, pending-poll index, and video cascade.
