import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  { path: 'dashboard', title: 'Dashboard · SQL Monitor', loadComponent: () => import('./pages/dashboard/dashboard').then((m) => m.Dashboard) },
  {
    path: 'latest-changes',
    title: 'Latest changes · SQL Monitor',
    loadComponent: () => import('./pages/latest-changes/latest-changes').then((m) => m.LatestChanges),
  },
  { path: 'errors', title: 'Errors · SQL Monitor', loadComponent: () => import('./pages/errors/errors').then((m) => m.Errors) },
  { path: 'jobs', title: 'SQL Agent jobs · SQL Monitor', loadComponent: () => import('./pages/jobs/jobs').then((m) => m.Jobs) },
  { path: 'sql', title: 'SQL activity · SQL Monitor', loadComponent: () => import('./pages/sql-activity/sql-activity').then((m) => m.SqlActivity) },
  { path: 'activity', title: 'Live activity · SQL Monitor', loadComponent: () => import('./pages/activity/activity').then((m) => m.Activity) },
  { path: 'tables', title: 'History tables · SQL Monitor', loadComponent: () => import('./pages/tables/tables').then((m) => m.Tables) },
  { path: 'modules/:module', title: 'Module · SQL Monitor', loadComponent: () => import('./pages/tables/tables').then((m) => m.Tables) },
  {
    path: 'tables/:name',
    title: 'Table · SQL Monitor',
    loadComponent: () => import('./pages/table-viewer/table-viewer').then((m) => m.TableViewer),
  },
  { path: '**', redirectTo: 'dashboard' },
];
