/**
 * Central FAQ access control and category normalization.
 *
 * HR FAQs are restricted to SUPER_ADMIN and HR_ADMIN only.
 * All other users can access GA, ACC, and OTHERS.
 */

export type FaqCategory = 'HR' | 'GA' | 'ACC' | 'OTHERS';

const FAQ_CATEGORIES: readonly FaqCategory[] = ['HR', 'GA', 'ACC', 'OTHERS'] as const;

/**
 * Normalize any input string to a canonical FAQ category.
 * Use this everywhere a category value is read, written, compared, or displayed.
 */
export function normalizeFaqCategory(input: unknown): FaqCategory {
  const raw = String(input || '').trim().toUpperCase().replace(/[\s_\-]+/g, '');
  if (raw === 'HR' || raw === 'HUMANRESOURCES' || raw === 'HUMANRESOURCE') return 'HR';
  if (raw === 'GA' || raw === 'GENERALAFFAIRS') return 'GA';
  if (raw === 'ACC' || raw === 'ACCOUNTING' || raw === 'ACCOUNTS' || raw === 'FINANCE') return 'ACC';
  return 'OTHERS';
}

/**
 * Return the list of FAQ categories a given role is allowed to see.
 *
 * | Role          | HR  | GA  | ACC | OTHERS |
 * |---------------|-----|-----|-----|--------|
 * | SUPER_ADMIN   | Yes | Yes | Yes | Yes    |
 * | HR_ADMIN      | Yes | Yes | Yes | Yes    |
 * | all others    | No  | Yes | Yes | Yes    |
 */
export function getAllowedFaqCategories(roleCode: string): FaqCategory[] {
  const role = String(roleCode || '').toUpperCase();
  if (role === 'SUPER_ADMIN' || role === 'HR_ADMIN') {
    return [...FAQ_CATEGORIES];
  }
  return ['GA', 'ACC', 'OTHERS'];
}

/**
 * Check whether a specific role can view a specific FAQ category.
 */
export function canAccessFaqCategory(roleCode: string, category: string): boolean {
  const normalized = normalizeFaqCategory(category);
  return getAllowedFaqCategories(roleCode).includes(normalized);
}

/**
 * Map a department_code (as stored in chat_history_messages) to the
 * canonical FAQ category used for access control.
 *
 * The database stores: HR, GA, ACC, OTHER, SYSTEMS, etc.
 * FAQ categories are: HR, GA, ACC, OTHERS
 */
export function departmentToFaqCategory(departmentCode: string): FaqCategory {
  const code = String(departmentCode || '').toUpperCase().trim();
  if (code === 'HR') return 'HR';
  if (code === 'GA') return 'GA';
  if (code === 'ACC') return 'ACC';
  return 'OTHERS';
}
