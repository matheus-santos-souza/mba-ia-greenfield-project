> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# Repositories (`*.repository.ts`)

Repository behavior is SQL/transaction behavior. Test it against real PostgreSQL; mocked `Repository`/`EntityManager` calls cannot prove predicates, locks, constraints, or atomicity.

## Required coverage

- exact `where` semantics, relation loading, ordering, and pagination;
- state transitions under `pessimistic_write`;
- multi-entity atomicity and rollback;
- unique/check/FK constraints used as idempotency or safety boundaries;
- concurrent claim behavior such as `FOR UPDATE SKIP LOCKED` and leases;
- transactional outbox creation in the same commit as aggregate state.

Use `createTestDataSource()` and `cleanAllTables()`. Run sequentially and destroy standalone DataSources in `afterAll`.

For Phase 03, repository integration tests must prove:

- upload completion produces exactly one `video.processing.requested` event;
- repeated completion is idempotent;
- outbox claimers do not claim the same event concurrently;
- failed publication scheduling updates attempts/availability without losing the event;
- expired upload cleanup claims are skip-locked and remain eligible when storage abort fails;
- worker success/failure transitions preserve `ready` idempotency and terminal `error` semantics.

Unit-test a service's branch decisions with a mocked repository only when those decisions are independently valuable. Keep the real repository integration test as the database contract.
