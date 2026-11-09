import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Merge Tailwind class names safely, resolving conflicts.
 * Used by all shadcn-vue v2 components.
 */
export function cn(...inputs) {
  return twMerge(clsx(inputs))
}
