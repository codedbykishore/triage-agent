import { useState, useEffect } from "react";
import { API_BASE_URL } from "../config";

/**
 * BUG: This component has a React rendering error.
 * 
 * It fetches user profile data from the API. The API returns the data correctly,
 * but the component tries to render `user.preferences.theme.toUpperCase()` 
 * BEFORE the useEffect completes. On first render, `user` is null, causing:
 * 
 *   TypeError: Cannot read properties of null (reading 'preferences')
 * 
 * This crashes the React component tree. The ErrorBoundary catches it and
 * reports it to /api/log-error → CloudWatch → auto-triage agent.
 */
function UserProfile() {
    const [user, setUser] = useState(null);

    useEffect(() => {
        fetch(`${API_BASE_URL}/api/users/usr-1001/profile`)
            .then((res) => res.json())
            .then((data) => {
                if (data.success) {
                    setUser(data.data);
                }
            })
            .catch(() => { });
    }, []);

    // BUG: Accessing user.preferences.theme without null check
    // On initial render, user is null → TypeError → ErrorBoundary catches it
    const currentTheme = user.preferences.theme.toUpperCase();

    return (
        <div className="page">
            <h1>My Profile</h1>
            <div className="profile-card">
                <img src={user.avatar} alt={user.name} className="avatar" />
                <div className="profile-info">
                    <h2>{user.name}</h2>
                    <p>{user.email}</p>
                    <p>Role: {user.role}</p>
                    <p>Theme: {currentTheme}</p>
                </div>
            </div>
            <div className="activity-section">
                <h3>Recent Activity</h3>
                <ul>
                    {user.recentActivity.map((item, idx) => (
                        <li key={idx}>{item.action} — {new Date(item.timestamp).toLocaleDateString()}</li>
                    ))}
                </ul>
            </div>
        </div>
    );
}

export default UserProfile;
