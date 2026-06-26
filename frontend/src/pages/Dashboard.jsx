import { useState, useEffect } from "react";
import { API_BASE_URL } from "../config";

function Dashboard() {
    const [health, setHealth] = useState(null);

    useEffect(() => {
        fetch(`${API_BASE_URL}/health`)
            .then((res) => res.json())
            .then(setHealth)
            .catch(() => setHealth({ status: "unreachable" }));
    }, []);

    return (
        <div className="page">
            <h1>Dashboard</h1>
            <div className="stats-grid">
                <div className="stat-card">
                    <h3>Total Orders</h3>
                    <p className="stat-value">1,247</p>
                </div>
                <div className="stat-card">
                    <h3>Revenue (MTD)</h3>
                    <p className="stat-value">$48,392</p>
                </div>
                <div className="stat-card">
                    <h3>Active Users</h3>
                    <p className="stat-value">312</p>
                </div>
                <div className="stat-card">
                    <h3>API Status</h3>
                    <p className="stat-value">{health ? health.status : "loading..."}</p>
                </div>
            </div>
        </div>
    );
}

export default Dashboard;
