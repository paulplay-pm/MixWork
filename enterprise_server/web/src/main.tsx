import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { apiClient } from './api/client';
import { startSessionRefresh } from './auth/sessionRefresh';
import { useAuthStore } from './auth/store';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
});

// Wire the API client to the auth store. The base URL is the SPA's own
// origin so the Hono server handles /auth, /admin, /api, etc. The dev
// Vite proxy (vite.config.ts) forwards them to localhost:8787.
apiClient.setBaseUrl(window.location.origin);
apiClient.setTokenProvider(() => useAuthStore.getState().token);
apiClient.setRefresh(async () => {
  const r = await apiClient.post<{ token: string }>('/auth/refresh');
  useAuthStore.getState().login(r.token);
});

// A session that cannot be renewed is dead: drop it so the app returns to
// the login page instead of failing every request with a bare 401.
apiClient.setSessionExpiredHandler(() => {
  useAuthStore.getState().logout('session-expired');
});

// Proactive rotation: the enterprise JWT lives ~1h and /auth/refresh
// re-verifies the CURRENT token, so an expired one can never be renewed.
// Rotate while it is still valid (see auth/sessionRefresh.ts).
startSessionRefresh({
  getToken: () => useAuthStore.getState().token,
  refresh: async () => (await apiClient.post<{ token: string }>('/auth/refresh')).token,
  persist: (token) => useAuthStore.getState().login(token),
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>
);