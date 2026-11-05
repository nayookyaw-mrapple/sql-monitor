import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { ContextService } from './context.service';

/** Adds the selected database, Site and Season to every API request. */
export const contextInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith('/api/')) return next(req);
  const ctx = inject(ContextService);
  const headers: Record<string, string> = {};
  const target = ctx.targetId();
  if (target && !req.headers.has('X-Target')) headers['X-Target'] = encodeURIComponent(target);
  const siteId = ctx.siteId();
  const season = ctx.season();
  if (siteId !== null) headers['X-Site-Id'] = String(siteId);
  if (season !== null) headers['X-Season'] = String(season);
  return next(req.clone({ setHeaders: headers }));
};
