import { useEffect, useState } from 'react';
import ImportBatchesPage from '../pages/ImportBatchesPage';
import OverviewPage from '../pages/OverviewPage';
import ReconcilePage from '../pages/ReconcilePage';
import RunDetailsPage from '../pages/RunDetailsPage';
import ExceptionsPage from '../pages/ExceptionsPage';
import { EmptyState } from '../components/AsyncState';
import { navigationItems, parseHashRoute, routeMetadata, type AppRoute } from './routing';

function useHashRoute(): AppRoute {
  const [route, setRoute] = useState(() => parseHashRoute(window.location.hash));

  useEffect(() => {
    const updateRoute = () => setRoute(parseHashRoute(window.location.hash));
    window.addEventListener('hashchange', updateRoute);

    if (!window.location.hash) {
      window.history.replaceState(null, '', '#/overview');
    }

    return () => window.removeEventListener('hashchange', updateRoute);
  }, []);

  return route;
}

function App() {
  const route = useHashRoute();
  const metadata = routeMetadata(route);
  const activeNavigation =
    route.kind === 'run-details' || route.kind === 'not-found' ? undefined : route.kind;

  const placeholder =
    route.kind === 'not-found'
      ? {
          title: 'We could not find that page',
          message: `The route “${route.path}” is not part of this workspace.`,
          action: (
            <a className="secondary-button" href="#/overview">
              Return to overview
            </a>
          ),
        }
      : {
          title: `${metadata.title} is ready for the next stage`,
          message:
            'This workspace will display live information from the reconciliation API when its page is implemented.',
        };

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

      <aside className="sidebar" aria-label="Application sidebar">
        <a className="brand" href="#/overview" aria-label="Ledgerline overview">
          <span className="brand-mark" aria-hidden="true">
            L
          </span>
          <span>
            ledgerline<span className="brand-period">.</span>
          </span>
        </a>

        <p className="workspace-label">WORKSPACE</p>
        <nav className="primary-navigation" aria-label="Main navigation">
          {navigationItems.map((item) => {
            const active = item.kind === activeNavigation;
            return (
              <a
                className={`nav-link${active ? ' active' : ''}`}
                href={item.href}
                key={item.kind}
                aria-current={active ? 'page' : undefined}
              >
                <span className="nav-icon" aria-hidden="true">
                  {item.icon}
                </span>
                <span>{item.label}</span>
              </a>
            );
          })}
        </nav>

        <div className="sidebar-bottom">
          <span className="environment-dot" aria-hidden="true" />
          <span>Synthetic environment</span>
          <span className="sidebar-version">LEARNING PROJECT · V0.1</span>
        </div>
      </aside>

      <div className="main-panel">
        <header className="topbar">
          <nav className="breadcrumbs" aria-label="Breadcrumb">
            <ol>
              <li>Operations</li>
              <li aria-current="page">{metadata.title}</li>
            </ol>
          </nav>
          <div className="workspace-indicator">
            <span className="avatar" aria-hidden="true">
              S
            </span>
            <span>Sample workspace</span>
          </div>
        </header>

        <main className="content" id="main-content" tabIndex={-1}>
          <div className="eyebrow">
            <span className="live-dot" aria-hidden="true" />
            RECONCILIATION WORKSPACE
          </div>
          <div className="page-heading">
            <div>
              <h1>{metadata.title}</h1>
              <p className="subtitle">{metadata.description}</p>
            </div>
            <span className="environment-tag">SYNTHETIC DATA</span>
          </div>

          <div className="demo-notice" role="note">
            <span className="notice-icon" aria-hidden="true">
              i
            </span>
            <p>
              <strong>Demo workspace</strong>
              <span>All records are synthetic. No real trades or funds are involved.</span>
            </p>
          </div>

          {route.kind === 'overview' ? (
            <OverviewPage />
          ) : route.kind === 'imports' ? (
            <ImportBatchesPage />
          ) : route.kind === 'reconcile' ? (
            <ReconcilePage />
          ) : route.kind === 'run-details' ? (
            <RunDetailsPage runId={route.runId} />
          ) : route.kind === 'exceptions' ? (
            <ExceptionsPage />
          ) : (
            <EmptyState {...placeholder} />
          )}

          <footer className="page-footer">
            <span>
              LEDGERLINE <span aria-hidden="true">·</span> TRADE RECONCILIATION
            </span>
            <span>Built for learning. Powered by synthetic data.</span>
          </footer>
        </main>
      </div>
    </div>
  );
}

export default App;
