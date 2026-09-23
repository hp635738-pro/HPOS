/**
 * Minimal class combiner for shadcn-style components (components.json
 * aliases "utils" here). Dependency-free: HPOS keeps the dep surface small,
 * so no clsx/tailwind-merge — callers never pass conflicting classes.
 */
export function cn(...inputs: Array<string | false | null | undefined>) {
  return inputs.filter(Boolean).join(' ')
}
