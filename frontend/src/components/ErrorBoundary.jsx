import { Component } from "react";
import { API_BASE_URL } from "../config";

class ErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error) {
        return { hasError: true, error };
    }

    componentDidCatch(error, errorInfo) {
        // Report the frontend error to the backend logging endpoint
        // This makes the client-side error appear in CloudWatch as [ERROR]
        fetch(`${API_BASE_URL}/api/log-error`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                message: error.message,
                stack: error.stack,
                componentStack: errorInfo.componentStack,
                url: window.location.pathname,
            }),
        }).catch(() => {
            // Silently fail — don't cascade errors
        });
    }

    render() {
        if (this.state.hasError) {
            return (
                <div className="error-page">
                    <h1>Something went wrong</h1>
                    <p>We've been notified and are looking into it.</p>
                    <p className="error-detail">{this.state.error?.message}</p>
                    <button onClick={() => window.location.reload()}>Reload Page</button>
                </div>
            );
        }
        return this.props.children;
    }
}

export default ErrorBoundary;
