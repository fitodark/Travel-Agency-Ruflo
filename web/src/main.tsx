import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { ProveedorSesion } from './auth/sesion';
import './index.css';

const qc = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

const raiz = document.getElementById('root');
if (!raiz) throw new Error('falta #root');

createRoot(raiz).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <ProveedorSesion>
          <App />
        </ProveedorSesion>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
