import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider, useAuth } from './hooks/useAuth';
import Layout from './components/Layout';
import Login from './pages/Login';
import Register from './pages/Register';
import Dashboard from './pages/Dashboard';
import Products from './pages/Products';
import Sales from './pages/Sales';
import Quotes from './pages/Quotes';
import Expenses from './pages/Expenses';
import Customers from './pages/Customers';
import Shipping from './pages/Shipping';
import Reports from './pages/Reports';
import Settings from './pages/Settings';
import CreditTracker from './pages/CreditTracker';
import Inventory from './pages/Inventory';
import Consultants from './pages/Consultants';
import Store from './pages/Store';
import SuperadminPanel from './pages/SuperadminPanel';
import ConsultantDashboard from './pages/ConsultantDashboard';
import ConsultantStock from './pages/ConsultantStock';
import Targets from './pages/Targets';
import MoneySplits from './pages/MoneySplits';
import Warehouse from './pages/Warehouse';
import StockAllocations from './pages/StockAllocations';

// Store domains — serve store directly, no admin
const STORE_DOMAINS = { 'store.privtech.net': 'privtech-solutions' };
const isStoreDomain = window.location.hostname in STORE_DOMAINS;

function PrivateRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="flex items-center justify-center h-screen"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" /></div>;
  return user ? children : <Navigate to="/login" />;
}

function DashboardRouter() {
  const { user } = useAuth();
  if (user?.role === 'superadmin') return <Navigate to="/superadmin" />;
  if (user?.role === 'consultant') return <ConsultantDashboard />;
  if (user?.role === 'inventory') return <Navigate to="/warehouse" />;
  if (user?.role === 'purchasing') return <Navigate to="/expenses" />;
  return <Dashboard />;
}

function AdminOnly({ children }) {
  const { user } = useAuth();
  if (user?.role === 'consultant' || user?.role === 'inventory' || user?.role === 'purchasing') return <Navigate to="/" />;
  return children;
}

// Sales/credit/my-stock are open to admin+consultant today; inventory role gets its own
// restricted Warehouse page instead, since those pages expose pricing/CRUD it shouldn't see.
function NotInventory({ children }) {
  const { user } = useAuth();
  if (user?.role === 'inventory') return <Navigate to="/warehouse" />;
  if (user?.role === 'purchasing') return <Navigate to="/expenses" />;
  return children;
}

function WarehouseRoute({ children }) {
  const { user } = useAuth();
  if (user?.role === 'consultant' || user?.role === 'purchasing') return <Navigate to="/" />;
  return children;
}

// Purchasing role records stock purchases and running costs; admins keep full access.
function ExpensesRoute({ children }) {
  const { user } = useAuth();
  if (user?.role === 'consultant' || user?.role === 'inventory') return <Navigate to="/" />;
  return children;
}

function AppRoutes() {
  const { user } = useAuth();

  if (isStoreDomain) {
    return (
      <Routes>
        <Route path="*" element={<Store />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/store/:slug" element={<Store />} />
      <Route path="/store/:slug/payment-result" element={<Store />} />
      <Route path="/login" element={user ? <Navigate to="/" /> : <Login />} />
      <Route path="/register" element={user ? <Navigate to="/" /> : <Register />} />
      <Route path="/" element={<PrivateRoute><Layout /></PrivateRoute>}>
        <Route index element={<DashboardRouter />} />
        <Route path="superadmin" element={<SuperadminPanel />} />
        <Route path="products" element={<AdminOnly><Products /></AdminOnly>} />
        <Route path="sales" element={<NotInventory><Sales /></NotInventory>} />
        <Route path="quotes" element={<NotInventory><Quotes /></NotInventory>} />
        <Route path="expenses" element={<ExpensesRoute><Expenses /></ExpensesRoute>} />
        <Route path="customers" element={<AdminOnly><Customers /></AdminOnly>} />
        <Route path="shipping" element={<AdminOnly><Shipping /></AdminOnly>} />
        <Route path="credit" element={<NotInventory><CreditTracker /></NotInventory>} />
        <Route path="inventory" element={<AdminOnly><Inventory /></AdminOnly>} />
        <Route path="stock-allocations" element={<AdminOnly><StockAllocations /></AdminOnly>} />
        <Route path="consultants" element={<AdminOnly><Consultants /></AdminOnly>} />
        <Route path="my-stock" element={<NotInventory><ConsultantStock /></NotInventory>} />
        <Route path="warehouse" element={<WarehouseRoute><Warehouse /></WarehouseRoute>} />
        <Route path="reports" element={<AdminOnly><Reports /></AdminOnly>} />
        <Route path="targets" element={<AdminOnly><Targets /></AdminOnly>} />
        <Route path="money-splits" element={<AdminOnly><MoneySplits /></AdminOnly>} />
        <Route path="settings" element={<AdminOnly><Settings /></AdminOnly>} />
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
