import { Component, type ErrorInfo, type ReactNode } from 'react';
import { BrandMark } from '../components/BrandMark';

export class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Woody page rendering failed', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <main className="boot-screen" role="alert">
      <BrandMark/>
      <strong>This Woody page could not be displayed.</strong>
      <span>Reload the page. If it happens again, return to the dashboard and report which page caused it.</span>
      <div className="page-actions"><button className="button primary" onClick={() => window.location.reload()}>Reload</button><a className="button" href="/dashboard">Dashboard</a></div>
    </main>;
  }
}
