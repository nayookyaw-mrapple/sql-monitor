import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  { path: 'dashboard', title: 'Dashboard · NAY-Monitor', loadComponent: () => import('./pages/dashboard/dashboard').then((m) => m.Dashboard) },
  {
    path: 'latest-changes',
    title: 'Latest changes · NAY-Monitor',
    loadComponent: () => import('./pages/latest-changes/latest-changes').then((m) => m.LatestChanges),
  },
  { path: 'errors', title: 'Errors · NAY-Monitor', loadComponent: () => import('./pages/errors/errors').then((m) => m.Errors) },
  { path: 'sql', title: 'SQL activity · NAY-Monitor', loadComponent: () => import('./pages/sql-activity/sql-activity').then((m) => m.SqlActivity) },
  { path: 'activity', title: 'Live activity · NAY-Monitor', loadComponent: () => import('./pages/activity/activity').then((m) => m.Activity) },
  { path: 'tables', title: 'History tables · NAY-Monitor', loadComponent: () => import('./pages/tables/tables').then((m) => m.Tables) },
  { path: 'modules/:module', title: 'Module · NAY-Monitor', loadComponent: () => import('./pages/tables/tables').then((m) => m.Tables) },
  {
    path: 'tables/:name',
    title: 'Table · NAY-Monitor',
    loadComponent: () => import('./pages/table-viewer/table-viewer').then((m) => m.TableViewer),
  },
  { path: '**', redirectTo: 'dashboard' },
];
