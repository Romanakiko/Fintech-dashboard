import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  {
    path: 'dashboard',
    title: 'Dashboard – Realtime Fintech Dashboard',
    loadComponent: () => import('./features/dashboard/dashboard.page').then((m) => m.DashboardPage),
  },
  {
    path: 'settings',
    title: 'Settings – Realtime Fintech Dashboard',
    loadComponent: () => import('./features/settings/settings.page').then((m) => m.SettingsPage),
  },
  { path: '**', redirectTo: 'dashboard' },
];
