> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# Mock Health Rules

## The Boundary Rule

**Mock across architecturally significant boundaries, not within.**

In NestJS terms, this means:

| Dependency type | In unit tests | In integration tests | In E2E tests |
|---|---|---|---|
| **Owned services** (services you wrote) | Mock with `useValue` | Use real (or mock if unrelated) | Use real |
| **Configured libs** (JwtModule, CacheModule, ThrottlerModule) | Use real with test config | Use real | Use real |
| **Side-effect ports** (storage, queue, media, email) | Mock the owned port for branch logic | Use real MinIO, Redis/BullMQ, FFmpeg/FFprobe, or Mailpit when proving that contract | Use real backend dependencies required by the HTTP flow |
| **Database** (TypeORM repositories) | Mock in unit tests | Use real (Docker PostgreSQL) | Use real |
| **Password hashing** (argon2) | Use real when hashing is the behavior; otherwise mock the owned auth/user boundary | Use real | Use real |

## When a Mock is Healthy

A mock is healthy when:
1. **You can describe the test's purpose without mentioning the mock.** If the test description is "should call `usersService.findByEmail` with the correct argument," the mock is the test — that's a wiring test.
2. **The mock replaces a dependency at a boundary, not an internal collaborator.** Mocking `UsersService` in `AuthService`'s test is healthy — `UsersService` has its own tests. Mocking a private method of `AuthService` is unhealthy.
3. **The mock doesn't hide behavior the test should verify.** Mocking `JwtService.sign()` to return `'fake-token'` hides whether your JWT configuration is correct.

## When a Mock is Unhealthy

A mock is unhealthy when:
- **Many mocks are needed to set up one test** — signal that the unit under test has too many responsibilities. Either rewrite as an integration test or split the service.
- **The mock replicates the implementation** — `jest.fn().mockReturnValue(expectedResult)` where `expectedResult` is the same value the real code returns. This is a mirror test.
- **The mock conceals a system boundary** — mocking a repository in a test that should verify the query is correct. The query IS the behavior.
- **The mock replaces the protocol being claimed** — an in-memory buffer cannot prove S3 multipart/range semantics, a fake array cannot prove BullMQ retry/deduplication, and fixture bytes cannot prove FFmpeg compatibility.

## NestJS Mocking Patterns

### Preferred: `useValue` in test module

```typescript
const module = await Test.createTestingModule({
  providers: [
    AuthService,
    { provide: UsersService, useValue: { findByEmail: jest.fn() } },
  ],
}).compile();
```

### When to use `overrideProvider`

Use `overrideProvider` when importing a real module but needing to replace one provider:

```typescript
const module = await Test.createTestingModule({
  imports: [AuthModule],
})
  .overrideProvider(UsersService)
  .useValue({ findByEmail: jest.fn() })
  .compile();
```

### When to use `jest.spyOn`

Use `jest.spyOn` when you want to observe a call on a real instance without replacing it:

```typescript
const spy = jest.spyOn(jwtService, 'sign');
await authService.login(credentials);
expect(spy).toHaveBeenCalledWith(expect.objectContaining({ sub: userId }));
```

**Caution:** If the spy assertion is the ONLY assertion in the test, you're writing a wiring test. Spies should supplement behavior assertions, not replace them.

### Mock cleanup

```typescript
afterEach(() => {
  jest.restoreAllMocks(); // restores spies to original implementations
});
```

Use `jest.restoreAllMocks()` in `afterEach` to prevent leaks between tests. Prefer `restoreAllMocks` over `clearAllMocks` — `restoreAllMocks` also undoes `jest.spyOn`.

## The Litmus Test

For every mock in a test, ask: **"Can I describe what observable behavior this test validates without referencing mock interactions?"**

- **Yes** → the mock is healthy; it's isolating a dependency so you can test the unit's behavior
- **No** → the test is verifying wiring, not behavior; rewrite or delete it
