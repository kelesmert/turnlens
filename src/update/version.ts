/**
 * Exactly three dot-separated runs of digits, anchored at both ends.
 *
 * Deliberately narrower than semver. A prerelease tag, build metadata or a
 * fourth segment fails here and produces no notice, which is the whole reason
 * this file can exist without the `semver` package: the shapes it cannot judge
 * confidently, it declines to judge at all. The cost of that is a notice that
 * does not appear; there is no shape it can get wrong.
 */
const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/u;

/**
 * Whether `candidate` is a later release than `current`.
 *
 * False whenever either side is unreadable, so an unexpected value from the
 * registry can only ever silence the notice, never trigger one.
 */
export function isNewer(candidate: string, current: string): boolean {
  const left = parse(candidate);
  const right = parse(current);
  if (left === undefined || right === undefined) return false;

  for (let index = 0; index < left.length; index += 1) {
    // Non-null: both are fixed-length triples from the same pattern.
    const a = left[index] as number;
    const b = right[index] as number;
    if (a !== b) return a > b;
  }
  return false;
}

/** The three numbers, or nothing. Compared as numbers so `10` beats `9`. */
function parse(version: string): readonly [number, number, number] | undefined {
  const match = RELEASE.exec(version);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
