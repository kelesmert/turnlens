/**
 * The two lines a run prints when a newer TurnLens has been published.
 *
 * Plain text, no colour. A renderer never decides whether colour is on; a
 * `Paint` is passed in by the caller, and this returns lines a caller may paint
 * or leave alone.
 *
 * Both versions are named because "an update is available" without them leaves
 * the reader unable to tell a patch from the release that removed their flag.
 */
export function formatUpdateNotice(latest: string, current: string): readonly string[] {
  return [
    `TurnLens ${latest} is available. You have ${current}.`,
    "  npm install -g turnlens@latest",
  ];
}
