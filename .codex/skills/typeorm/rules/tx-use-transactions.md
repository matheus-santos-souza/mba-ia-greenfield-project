---
title: Use Transactions for Multi-Entity Operations
impact: MEDIUM-HIGH
impactDescription: Multi-entity saves without transactions cause partial writes and data inconsistency
tags: transaction, query-runner, atomicity, consistency
---

## Use Transactions for Multi-Entity Operations

**Impact: MEDIUM-HIGH (saves without transactions cause partial writes and data inconsistency)**

Any operation that modifies multiple entities must be wrapped in a transaction.

**Incorrect (multiple saves without transaction):**

```typescript
// If the second save fails, the first is already committed — inconsistent state
const user = userRepository.create({ email: "user@example.com", name: "User" });
await userRepository.save(user);

const post = postRepository.create({ title: "First Post", author: user });
await postRepository.save(post); // If this fails, user exists without the post
```

**Correct — Option 1: QueryRunner (full control):**

```typescript
const queryRunner = AppDataSource.createQueryRunner();
await queryRunner.connect();
await queryRunner.startTransaction();

try {
  const user = queryRunner.manager.create(User, {
    email: "user@example.com",
    name: "User",
  });
  await queryRunner.manager.save(user);

  const post = queryRunner.manager.create(Post, {
    title: "First Post",
    author: user,
  });
  await queryRunner.manager.save(post);

  await queryRunner.commitTransaction();
} catch (error) {
  await queryRunner.rollbackTransaction();
  throw error;
} finally {
  await queryRunner.release(); // Always release the QueryRunner
}
```

**Correct — Option 2: Transaction callback (simpler):**

```typescript
await AppDataSource.transaction(async (manager) => {
  const user = manager.create(User, {
    email: "user@example.com",
    name: "User",
  });
  await manager.save(user);

  const post = manager.create(Post, {
    title: "First Post",
    author: user,
  });
  await manager.save(post);
  // Auto-commits on success, auto-rollbacks on error
});
```

**Key points:**
- Use **QueryRunner** when you need manual control (e.g., conditional commits, savepoints)
- Use **transaction callback** for simpler cases — it handles commit/rollback automatically
- Always `release()` the QueryRunner in a `finally` block
- Use `queryRunner.manager` (not the global repository) inside transactions
- In NestJS, inject `DataSource` and use `dataSource.transaction()` or `dataSource.createQueryRunner()`
- Lock aggregate rows before state transitions that can race (`pessimistic_write` for complete/abort/process flows), and keep idempotency checks inside the transaction.
- For reliable post-commit jobs, insert a transactional outbox event in the same transaction as the domain state. Publish to Redis/BullMQ after commit; do not make PostgreSQL + Redis a non-atomic dual write.
- Prefer committing before Redis/MinIO/FFmpeg/SMTP work. The project has one deliberate bounded exception: expired multipart cleanup keeps a `FOR UPDATE SKIP LOCKED` row lock while aborting that MinIO session, then persists `aborted` before commit so concurrent cleaners cannot duplicate the abort. Keep this batch small and covered by a real concurrency integration test. Never hold transactions across media transfer/transcoding, polling sleeps, or unbounded external waits.

Reference: [TypeORM Transactions](https://typeorm.io/transactions)
