/**
 * Spicy Lyrics' own DOM: the lyrics page and the NPV card around it.
 *
 * Observers that watch Spotify's UI for something specific see every mutation
 * in their subtree, ours included, and the lyrics virtualizer mounts and
 * unmounts rows on every line change. Nothing in here is what such an observer
 * is looking for, so it can drop these records before any selector work.
 */
const OWN_ROOTS = "#SpicyLyricsPage, #SpicyLyricsNPVCard";

export function IsOwnMutation(record: MutationRecord): boolean {
  const target = record.target;
  return target instanceof Element && target.closest(OWN_ROOTS) !== null;
}
