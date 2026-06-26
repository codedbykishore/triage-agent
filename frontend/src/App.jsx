import { Routes, Route, NavLink } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import Orders from "./pages/Orders";
import UserProfile from "./pages/UserProfile";
import ErrorBoundary from "./components/ErrorBoundary";

function App() {
    return (
        <div className="app">
            <nav className="sidebar">
                <div className="logo">
                    <h2>OrderFlow</h2>
                </div>
                <ul className="nav-links">
                    <li>
                        <NavLink to="/" end>Dashboard</NavLink>
                    </li>
                    <li>
                        <NavLink to="/orders">Orders</NavLink>
                    </li>
                    <li>
                        <NavLink to="/user/profile">My Profile</NavLink>
                    </li>
                </ul>
            </nav>
            <main className="content">
                <ErrorBoundary>
                    <Routes>
                        <Route path="/" element={<Dashboard />} />
                        <Route path="/orders" element={<Orders />} />
                        <Route path="/user/profile" element={<UserProfile />} />
                    </Routes>
                </ErrorBoundary>
            </main>
        </div>
    );
}

export default App;
