export const SKIP_PREFIXES = [
  '<local-command-caveat>',
  '<command-name>',
  '<system-reminder>',
  '<system>',
  '<function_calls>',
] as const;

export function shouldSkipPrefixedText(text: string): boolean {
  return SKIP_PREFIXES.some((prefix) => text.startsWith(prefix));
}
