---
name: typescript-best-practices
description: Apply robust TypeScript practices when generating, reviewing, refactoring, or designing TypeScript code, modules, public APIs, and JavaScript-to-TypeScript migrations. Use for .ts and .tsx work involving type safety, compiler configuration, module boundaries, error modeling, or maintainability. Do not use as the primary guide for framework-specific conventions or runtime debugging unless the issue also involves TypeScript types or configuration.
---

# TypeScript Best Practices

Produce TypeScript that is safe, maintainable, consistent with the repository, and appropriate for the target runtime.

## Operating Principles

1. Inspect the project before changing code.
2. Preserve existing behavior unless the task explicitly requests a behavior change.
3. Follow repository conventions when they are deliberate and type-safe.
4. Prefer simple types and direct code over clever abstractions.
5. Validate untrusted data at runtime; TypeScript types do not validate runtime values.
6. Run the project's existing type-check, lint, test, and build commands after changes.

## When to Apply

Apply this skill when:

- Generating or reviewing `.ts` or `.tsx` files
- Designing modules, services, libraries, or public APIs
- Refactoring JavaScript to TypeScript
- Improving type safety or compiler configuration
- Modeling domain states, errors, or external data
- Answering questions about TypeScript types and patterns

This skill may be used alongside framework-specific guidance. Framework conventions take precedence for framework architecture, while these rules still apply to the TypeScript itself.

Do not treat this skill as the primary debugging workflow for runtime-only failures. Use debugging tools first, then apply this guidance when the cause involves types, unsafe boundaries, or compiler settings.

## Required Workflow

### 1. Inspect the Repository

Before writing code, inspect relevant project files when available:

- `package.json`, lockfiles, and package-manager scripts
- `tsconfig.json` and extended TypeScript configurations
- ESLint, formatter, test, and build configuration
- Nearby modules and tests
- Runtime and module system: Node.js, Deno, Bun, browser, ESM, or CommonJS

Do not introduce a different module-resolution style, import-extension convention, test framework, formatter, or package manager without a clear reason.

### 2. Identify Boundaries

Treat these as trust boundaries that require runtime validation or explicit normalization:

- `JSON.parse`
- HTTP requests and responses
- Environment variables
- Command-line arguments
- File contents
- Database results without reliable generated types
- Third-party library values typed as `any`
- Messages from queues, workers, or browser storage

### 3. Design Types Before Complex Implementation

For non-trivial changes:

- Define the valid states and invariants.
- Use discriminated unions for mutually exclusive states.
- Decide which failures are expected and which are exceptional.
- Keep public contracts stable and implementation details private.

### 4. Implement the Smallest Cohesive Change

Avoid unrelated rewrites. Prefer cohesive modules over both god files and excessive one-type-per-file fragmentation.

### 5. Verify

Use commands already defined by the repository. Typical checks include:

- Type checking
- Linting
- Unit or integration tests
- Production build

For example, use the project's actual package manager and scripts rather than assuming `npm`, `deno`, or a custom script exists.

## Type Safety

### Prefer `unknown` at Untrusted Boundaries

Use `unknown` when a value's type is not established, then narrow or validate it.

```ts
export function stringifyInput(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);

  throw new TypeError("Expected a string or number");
}
```

Avoid `any` unless interoperability makes it unavoidable. Contain unavoidable `any` values at a narrow boundary and convert them to a safe type immediately.

### Narrow Instead of Asserting

Prefer control-flow narrowing, type guards, assertion functions, schema validation, or the `satisfies` operator over unsafe `as` assertions.

```ts
interface UserRecord {
  readonly id: string;
  readonly email: string;
}

function isUserRecord(value: unknown): value is UserRecord {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.email === "string";
}
```

A localized assertion may be acceptable when TypeScript cannot express a fact already guaranteed by a trusted API or an immediately preceding runtime check. Never use an assertion only to silence an error.

### Use Explicit Types at Important Boundaries

Add explicit parameter and return types to exported functions, public methods, callbacks exposed as APIs, and functions whose inferred type would be unclear or unstable.

Allow inference for simple local variables and private implementation details when it improves readability.

```ts
export function calculateTotal(items: readonly Item[]): number {
  return items.reduce((sum, item) => sum + item.price, 0);
}
```

Do not require explicit return annotations on every small internal function solely as a stylistic rule.

### Model Nullability Precisely

Use `strictNullChecks`. Distinguish among:

- A missing property
- A property whose value may be `undefined`
- An explicitly nullable value
- An empty string or empty collection

Optional chaining and nullish coalescing are useful, but they do not replace deliberate null checks.

```ts
const displayName = user.profile?.displayName ?? "Anonymous";

if (value != null) {
  // value is neither null nor undefined
}
```

### Prefer Exhaustive State Modeling

Use discriminated unions when values have a finite set of valid states.

```ts
type RequestState<T> =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "success"; readonly data: T }
  | { readonly status: "error"; readonly error: Error };

function assertNever(value: never): never {
  throw new Error(`Unhandled state: ${String(value)}`);
}
```

Use exhaustive `switch` handling where missing a case would be a defect.

## Immutability

Use `readonly` when callers should not mutate an input or exposed state.

```ts
interface User {
  readonly id: string;
  readonly email: string;
  readonly createdAt: Date;
  name: string;
}

export function renameUser(user: Readonly<User>, name: string): User {
  return { ...user, name };
}
```

Use `readonly T[]` or `ReadonlyArray<T>` for collection inputs that are not intentionally mutated.

Remember that TypeScript's `readonly` is shallow and compile-time only. Do not imply deep immutability or runtime freezing unless the implementation provides it.

Mutation is acceptable when it is local, intentional, and clearer or more efficient than copying. Do not copy large structures blindly in performance-sensitive code.

## Error Handling

### Distinguish Expected Failures from Exceptions

Use a discriminated result type for expected, recoverable outcomes when callers are reasonably expected to branch on failure.

```ts
type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

interface ValidationIssue {
  readonly code: "INVALID_JSON" | "INVALID_CONFIG";
  readonly message: string;
}

function parseConfig(input: string): Result<Config, ValidationIssue> {
  let value: unknown;

  try {
    value = JSON.parse(input) as unknown;
  } catch {
    return {
      ok: false,
      error: { code: "INVALID_JSON", message: "Configuration is not valid JSON" },
    };
  }

  if (!isConfig(value)) {
    return {
      ok: false,
      error: { code: "INVALID_CONFIG", message: "Configuration has an invalid shape" },
    };
  }

  return { ok: true, value };
}
```

Throw errors for exceptional failures, violated invariants, or APIs whose established contract uses exceptions. Do not use either `Result` or exceptions as a universal rule.

### Handle Caught Values Safely

Treat caught values as `unknown` and normalize them before reading properties.

```ts
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
```

Do not swallow errors silently. Add context when rethrowing, while preserving the original cause when supported.

```ts
throw new Error("Failed to load user settings", { cause: toError(error) });
```

## Functions and APIs

### Prefer Clear, Narrow Signatures

- Keep parameters focused.
- Use an options object when several optional parameters would be ambiguous.
- Avoid boolean parameters whose meaning is unclear at the call site.
- Do not introduce generics that do not preserve a useful relationship between inputs and outputs.
- Constrain generic parameters when the implementation depends on specific capabilities.

### Prefer Unions Over Unnecessary Overloads

Use union parameters when callers receive the same return type and the implementation handles the inputs uniformly.

```ts
function parseText(input: string | Uint8Array): ParsedData {
  const text = typeof input === "string" ? input : new TextDecoder().decode(input);
  return parseTextContent(text);
}
```

Use overloads only when they describe genuinely different call forms or when the return type depends on the input shape.

### Prefer Pure Logic Where Practical

Separate deterministic transformations from I/O when doing so improves testing and clarity. Do not force a functional style when a small stateful abstraction is clearer.

### Design Async Code Deliberately

- Return `Promise<T>` from public async APIs.
- Await or intentionally handle promises; do not leave floating promises accidentally.
- Preserve cancellation signals when the surrounding API supports them.
- Avoid sequential awaits when independent operations can safely run concurrently.
- Do not use `async` when a function only returns an existing promise and adds no behavior.

## Object and Type Design

### Choose `interface` or `type` Intentionally

Both are valid for object shapes.

Use an `interface` when declaration merging or class implementation is useful. Use a `type` for unions, intersections, tuples, mapped types, conditional types, primitives, and aliases where openness is not desired.

Follow the repository's established convention when either form is equally suitable.

### Prefer Literal Types for Closed Sets When Appropriate

String literal unions or `as const` objects are often convenient for finite values and align closely with JavaScript.

```ts
export const USER_ROLE = {
  Admin: "admin",
  User: "user",
  Guest: "guest",
} as const;

export type UserRole = (typeof USER_ROLE)[keyof typeof USER_ROLE];
```

Enums remain valid when their runtime object, reverse mapping, interoperability, or existing API contract is useful. Avoid uninitialized numeric enums for serialized external data because their values are less self-describing and easier to change accidentally.

### Use Index Signatures Only for Truly Dynamic Keys

Prefer explicit properties for known keys and `Record<Key, Value>` for a known finite key set. Use an index signature when keys are genuinely open-ended.

Enable or account for `noUncheckedIndexedAccess` so indexed reads are handled as potentially missing.

## Modules and Imports

- Keep modules cohesive and responsibilities clear.
- Avoid circular dependencies.
- Prefer explicit public entry points for packages and features.
- Use type-only imports and exports when required by the project's compiler settings.
- Do not enforce named versus default exports as a universal TypeScript rule; follow project and ecosystem conventions.
- Avoid broad wildcard barrel exports when they obscure ownership, create cycles, or expose internal modules. A deliberate package-level barrel can be appropriate.
- Match import specifiers to the runtime and compiler configuration. Deno commonly imports local `.ts` paths, while emitted ESM projects using `tsc` commonly write runtime `.js` specifiers for `.ts` source files.

```ts
export type { User } from "./user.js";
export { createUser } from "./user.js";
```

Do not copy the `.js` convention into Deno or the `.ts` convention into an emitting `tsc` project without checking configuration.

## Compiler and Lint Configuration

For a new project, prefer enabling `strict` mode. Also consider these options when compatible with the codebase and target ecosystem:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitReturns": true
  }
}
```

Treat compiler-option changes as project-wide migrations. Do not enable strict flags casually in an existing codebase without assessing resulting errors and scope.

When ESLint with typescript-eslint is already present, prefer its maintained recommended type-checked configurations over an arbitrary collection of one-off rules. Add stricter rules only when the project can support their type-checking cost and migration burden.

Useful policies often include:

- Disallowing unsafe `any` propagation
- Detecting floating promises
- Detecting unsafe assignments, calls, returns, and member access
- Requiring explicit types at module boundaries when the team values that tradeoff

Do not claim a lint rule is enabled unless it exists in the repository configuration.

## Code Organization

Organize by cohesive responsibility rather than by a fixed rule such as one symbol per file.

A module may contain:

1. Public types
2. Module-local types
3. Constants
4. Public implementation
5. Private helpers

Place public exports near a stable module boundary. Keep private helpers private. Split a module when it has unrelated reasons to change, becomes difficult to test, or creates dependency problems.

## Documentation

Add JSDoc to public APIs when it explains behavior that types alone cannot express, such as:

- Units and ranges
- Side effects
- Error behavior
- Performance characteristics
- Security constraints
- Non-obvious invariants

Avoid comments that merely restate names or types.

```ts
/**
 * Fetches a user and rejects when the request fails.
 *
 * @param id - Stable user identifier.
 * @param signal - Optional cancellation signal.
 */
export async function fetchUser(id: string, signal?: AbortSignal): Promise<User> {
  // Implementation
}
```

## Common Problems to Flag During Review

Flag these when they are relevant:

- Explicit or leaked `any`
- Unsafe type assertions and non-null assertions
- Unvalidated external data
- Missing null or `undefined` handling
- Impossible states represented by loose optional properties
- Mutable public inputs or exposed state without intent
- Floating promises
- Swallowed errors
- Overly broad generics
- Unnecessary overloads
- Circular dependencies
- Runtime-specific imports copied into the wrong toolchain
- Public APIs inferred from unstable implementation details
- Large unrelated refactors mixed into a focused change
- Tests that verify implementation details instead of observable behavior

## Review Output

When reviewing TypeScript code:

1. Report correctness and safety issues before style preferences.
2. Include the affected location when available.
3. Explain the concrete risk.
4. Provide a minimal fix or code example.
5. Separate required fixes from optional improvements.
6. State assumptions about runtime, TypeScript configuration, or external data.
7. Do not invent missing files, scripts, dependencies, or project conventions.

## Final Checklist

Before completing TypeScript work, confirm:

- Untrusted values are validated or narrowed from `unknown`.
- Exported APIs have clear and stable types.
- Nullability and optional properties are modeled intentionally.
- Expected failures and exceptional failures use appropriate contracts.
- Mutability is intentional.
- Assertions are justified and localized.
- Module and import syntax matches the actual runtime configuration.
- No unrelated architecture or dependency was introduced.
- Existing type-check, lint, test, and build commands pass, or failures are reported accurately.
