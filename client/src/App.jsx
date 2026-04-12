import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider, useAuth } from './hooks/useAuth';
import Layout from './components/Layout';
import Login from './pages/Login';
import Register from './pages/Register';
import Dashboard from './pages/Dashboard';
import Products from './pages/Products';
import Sales from './pages/Sales';
import Expenses from './pages/Expenses';
import Customers from './pages/Customers';
import Shipping from './pages/Shipping';
import Reports from './pages/Reports';
import Settings from './pages/Settings';
import CreditTracker from './pages/CreditTracker';
import Inventory from './pages/Inventory';
import Consultants from './pages/Consultants';
import SuperadminPanel from './pages/SuperadminPanel';

function PrivateRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="flex items-center justify-center h-screen"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" /></div>;
  return user ? children : <Navigate to="/login" />;
}

function DashboardRouter() {
  const { user } = useAuth();
  if (user?.role === 'superadmin') return <Navigate to="/superadmin" />;
  return <Dashboard />;
}

function AppRoutes() {
  const { user } = useAuth();

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" /> : <Login />} />
      <Route path="/register" element={user ? <Navigate to="/" /> : <Register />} />
      <Route path="/" element={<PrivateRoute><Layout /></PrivateRoute>}>
        <Route index element={<DashboardRouter />} />
        <Route path="superadmin" element={<SuperadminPanel />} />
        <Route path="products" element={<Products />} />
        <Route path="sales" element={<Sales />} />
        <Route path="expenses" element={<Expenses />} />
        <Route path="customers" element={<Customers />} />
        <Route path="shipping" element={<Shipping />} />
        <Route path="credit" element={<CreditTracker />} />
        <Route path="inventory" element={<Inventory />} />
        <Route path="consultants" element={<Consultants />} />
        <Route path="reports" element={<Reports />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
        <Toaster position="top-right" toastOptions={{ duration: 3000 }} />
      </AuthProvider>
    </BrowserRouter>
  );
}
