import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AppRouter } from '@/app/router';
import { I18nProvider } from '@/app/providers/I18nProvider';
import { ThemeProvider } from '@/app/providers/ThemeProvider';
import { AuthProvider } from '@/app/providers/AuthProvider';
import { OfflineProvider } from '@/app/providers/OfflineProvider';
import { ToastProvider } from '@/app/providers/ToastProvider';
import { ErrorBoundary } from '@/app/providers/ErrorBoundary';
import '@/styles/index.css';

/**
 * Entry point.
 *
 * Provider order matters: I18n and Theme are outermost because the error
 * boundary and every screen below need to render translated, themed content —
 * including when something has gone wrong.
 */

const container = document.getElementById('root');
if (!container) throw new Error('Root element not found');

createRoot(container).render(
  <StrictMode>
    <I18nProvider>
      <ThemeProvider>
        <ErrorBoundary>
          <BrowserRouter>
            <AuthProvider>
              <OfflineProvider>
                <ToastProvider>
                  <AppRouter />
                </ToastProvider>
              </OfflineProvider>
            </AuthProvider>
          </BrowserRouter>
        </ErrorBoundary>
      </ThemeProvider>
    </I18nProvider>
  </StrictMode>,
);
