import { toFiniteInt } from "../core/numbers.js";

/**
 * The width the live table should fit into, or `undefined` when there is none.
 *
 * `undefined` is not a failure. It is the answer for output that is not going
 * to a terminal at all -- a pipe or a redirect -- where there is no window to
 * fit and narrowing the table would drop columns from a recorded file.
 *
 * The environment is a parameter rather than a read of `process.env` so both
 * branches stay reachable from a test, which is the rule `src/options.ts`
 * already follows.
 */
export function terminalWidth(
  stream: NodeJS.WriteStream,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  if (stream.isTTY !== true) return undefined;
  return selectWidth(env.COLUMNS, stream.columns);
}

/**
 * Chooses between a declared width and a measured one.
 *
 * `COLUMNS` wins because it is the only way a user can correct a measurement
 * that is right about the window and wrong about what they wanted. Zero and
 * negative values are ignored from either source: a stream with no window to
 * report can answer zero, and a zero-width table is not a narrower table.
 */
export function selectWidth(
  columnsEnv: string | undefined,
  detected: number | undefined,
): number | undefined {
  const declared = toFiniteInt(columnsEnv);
  if (declared !== undefined && declared > 0) return declared;

  const measured = toFiniteInt(detected);
  return measured !== undefined && measured > 0 ? measured : undefined;
}
