import { QueryClient } from "@tanstack/react-query"

import { ApiRequestError } from "./api"

export const retryServerQuery = (failureCount: number, error: Error): boolean => {
  if (failureCount >= 2) return false
  if (error instanceof ApiRequestError) return error.status >= 500
  return error instanceof TypeError
}

export const createAppQueryClient = (): QueryClient => new QueryClient({
  defaultOptions: {
    mutations: { retry: false },
    queries: {
      retry: retryServerQuery,
      retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
    },
  },
})
