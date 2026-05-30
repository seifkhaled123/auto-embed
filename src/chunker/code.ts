/**
 * Language-tuned separator lists for the recursive splitter. The first
 * separator the text actually contains wins, so order from most-coarse
 * (class/function boundaries) to most-fine (whitespace).
 */
export const CODE_SEPARATORS: Record<string, string[]> = {
  typescript: ["\nexport class ", "\nexport function ", "\nclass ", "\nfunction ", "\nconst ", "\n\n", "\n", " ", ""],
  javascript: ["\nexport class ", "\nexport function ", "\nclass ", "\nfunction ", "\nconst ", "\n\n", "\n", " ", ""],
  python: ["\nclass ", "\ndef ", "\n\n", "\n", " ", ""],
  go: ["\nfunc ", "\ntype ", "\n\n", "\n", " ", ""],
  rust: ["\nfn ", "\nimpl ", "\nstruct ", "\nenum ", "\n\n", "\n", " ", ""],
  java: ["\npublic class ", "\nclass ", "\npublic ", "\nprivate ", "\nprotected ", "\n\n", "\n", " ", ""],
  unknown: ["\nclass ", "\nfunction ", "\ndef ", "\n\n", "\n", " ", ""],
};

export function separatorsForLanguage(language: string): string[] {
  return CODE_SEPARATORS[language] ?? CODE_SEPARATORS.unknown!;
}
