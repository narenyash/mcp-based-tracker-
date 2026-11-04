import { QueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => {
        const status = isAxiosError(err) ? err.response?.status : undefined;
        return status !== undefined && status < 500 ? false : count < 2;
      },
    },
  },
});
