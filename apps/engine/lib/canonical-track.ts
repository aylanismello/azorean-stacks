export function canonicalTrackKey(track: { artist: string; title: string }): string {
  return `${track.artist.normalize("NFKC").toLocaleLowerCase().trim()}::${track.title.normalize("NFKC").toLocaleLowerCase().trim()}`;
}

export function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, (character) => `\\${character}`);
}
