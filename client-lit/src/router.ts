import type { Route } from '@vaadin/router';

import { signal } from './store/reactive';
import './pages/console-page';

/**
 * The console is the landing page and loads eagerly; the log and about pages
 * arrive as their own chunks the first time someone navigates to them.
 */
export const routes: Route[] = [
  { path: '/', component: 'wt-console-page' },
  {
    path: '/log',
    component: 'wt-log-page',
    action: async () => {
      await import('./pages/log-page');
    },
  },
  {
    path: '/about',
    component: 'wt-about-page',
    action: async () => {
      await import('./pages/about-page');
    },
  },
  { path: '(.*)', redirect: '/' },
];

/** Where the router currently is, as a signal the nav can highlight from. */
export const currentPath = signal(window.location.pathname);

window.addEventListener('vaadin-router-location-changed', (event) => {
  const detail = (event as CustomEvent<{ location: { pathname: string } }>).detail;
  currentPath.set(detail.location.pathname);
});
