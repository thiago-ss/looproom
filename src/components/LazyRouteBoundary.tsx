import { Component, type ReactNode } from "react";
import { Alert } from "./arc/alert/alert";
import { Button } from "./ui/button";

export default class LazyRouteBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("Looproom screen failed to load", error);
  }

  render() {
    if (this.state.error) {
      return (
        <section className="page">
          <Alert tone="danger" title="Could not open this screen">
            The app may have updated. Reload to load the current version.
          </Alert>
          <Button onClick={() => window.location.reload()}>
            Reload workspace
          </Button>
        </section>
      );
    }
    return this.props.children;
  }
}
