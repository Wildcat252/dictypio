/**
 * iOS "Smart Punctuation" (on by default) turns typed ' and " into curly
 * quotes, -- into en/em dashes and ... into an ellipsis. Map them back so a
 * word typed on an iPhone compares equal to the transcript.
 */
export function straightenPunctuation(s: string): string {
  return s
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
}
