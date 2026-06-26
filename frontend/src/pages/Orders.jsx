import { useState, useEffect } from "react";
import { API_BASE_URL } from "../config";

function Orders() {
    const [orders, setOrders] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
        fetch(`${API_BASE_URL}/api/orders`)
            .then((res) => res.json())
            .then((data) => {
                if (data.success) {
                    setOrders(data.data);
                } else {
                    setError(data.message || "Failed to load orders");
                }
            })
            .catch((err) => setError(err.message));
    }, []);

    if (error) {
        return (
            <div className="page">
                <h1>Orders</h1>
                <div className="error-banner">
                    <p>⚠️ Failed to load orders: {error}</p>
                </div>
            </div>
        );
    }

    if (!orders) {
        return (
            <div className="page">
                <h1>Orders</h1>
                <p>Loading orders...</p>
            </div>
        );
    }

    return (
        <div className="page">
            <h1>Orders</h1>
            <table className="data-table">
                <thead>
                    <tr>
                        <th>Order ID</th>
                        <th>Customer</th>
                        <th>Status</th>
                        <th>Total</th>
                        <th>Card</th>
                    </tr>
                </thead>
                <tbody>
                    {orders.map((order) => (
                        <tr key={order.id}>
                            <td>{order.id}</td>
                            <td>{order.customerName}</td>
                            <td><span className={`badge badge-${order.status}`}>{order.status}</span></td>
                            <td>${order.total.toFixed(2)}</td>
                            <td>•••• {order.cardLast4}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

export default Orders;
