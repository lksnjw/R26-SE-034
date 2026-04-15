import { Component } from "react";
import EmptyState from "./EmptyState";

class ErrorBoundary extends Component {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return <EmptyState title="Something went wrong" />;
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
