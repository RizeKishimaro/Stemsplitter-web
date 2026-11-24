/** API base URL is configured per deployment; the UI can still run standalone. */
export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "/api/v1").replace(/\/+$/, "");

export function apiUrl(path: string): string {
  const normalizedPath = path.replace(/^\/+/, "");
  return `${API_BASE_URL}/${normalizedPath}`;
}
