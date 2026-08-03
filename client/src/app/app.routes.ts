import { Routes } from '@angular/router';

import { ConsolePage } from './pages/console-page';

/**
 * The console is the landing page and loads eagerly; the log and about pages
 * arrive as their own chunks the first time someone navigates to them — the
 * same split the Lit client makes.
 */
export const routes: Routes = [
  { path: '', component: ConsolePage },
  { path: 'log', loadComponent: () => import('./pages/log-page').then((m) => m.LogPage) },
  { path: 'about', loadComponent: () => import('./pages/about-page').then((m) => m.AboutPage) },
  { path: '**', redirectTo: '' },
];
