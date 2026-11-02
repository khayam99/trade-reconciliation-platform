export type AppRoute =
  | { kind: 'overview' }
  | { kind: 'imports' }
  | { kind: 'reconcile' }
  | { kind: 'run-details'; runId: string }
  | { kind: 'exceptions' }
  | { kind: 'not-found'; path: string };

export interface NavigationItem {
  kind: 'overview' | 'imports' | 'reconcile' | 'exceptions';
  label: string;
  href: string;
  icon: string;
}

export const navigationItems: NavigationItem[] = [
  { kind: 'overview', label: 'Overview', href: '#/overview', icon: '◫' },
  { kind: 'imports', label: 'Import batches', href: '#/imports', icon: '⇧' },
  { kind: 'reconcile', label: 'Reconcile', href: '#/reconcile', icon: '⇄' },
  { kind: 'exceptions', label: 'Exceptions', href: '#/exceptions', icon: '◎' },
];

export interface RouteMetadata {
  title: string;
  description: string;
}

export function parseHashRoute(hash: string): AppRoute {
  const routePath = hash.startsWith('#') ? hash.slice(1) : hash;
  const path = (routePath.split('?')[0] || '/overview').replace(/\/$/, '') || '/overview';

  switch (path) {
    case '/overview':
    case '/':
    case 'overview':
      return { kind: 'overview' };
    case '/imports':
    case 'imports':
      return { kind: 'imports' };
    case '/reconcile':
      return { kind: 'reconcile' };
    case '/exceptions':
    case 'exceptions':
      return { kind: 'exceptions' };
    default: {
      const runMatch = /^\/runs\/([^/]+)$/.exec(path);
      if (runMatch?.[1]) {
        try {
          return { kind: 'run-details', runId: decodeURIComponent(runMatch[1]) };
        } catch {
          return { kind: 'not-found', path };
        }
      }
      return { kind: 'not-found', path };
    }
  }
}

export function routeMetadata(route: AppRoute): RouteMetadata {
  switch (route.kind) {
    case 'overview':
      return { title: 'Overview', description: 'A clear view of your reconciliation operations.' };
    case 'imports':
      return {
        title: 'Import batches',
        description: 'Browse completed and in-progress source batches.',
      };
    case 'reconcile':
      return {
        title: 'Reconcile',
        description: 'Compare one completed ALPHA batch with one BRAVO batch.',
      };
    case 'run-details':
      return { title: 'Run details', description: `Reconciliation run ${route.runId}` };
    case 'exceptions':
      return {
        title: 'Exceptions',
        description: 'Review discrepancies created by reconciliation runs.',
      };
    case 'not-found':
      return {
        title: 'Page not found',
        description: 'The requested workspace page does not exist.',
      };
  }
}
