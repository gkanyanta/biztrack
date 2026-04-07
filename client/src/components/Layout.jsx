import { useState } from 'react';
import { Link, useLocation, Outlet } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import {
  FiHome, FiPackage, FiShoppingCart, FiDollarSign,
  FiUsers, FiTruck, FiBarChart2, FiSettings, FiLogOut, FiMenu, FiX, FiCreditCard, FiClipboard, FiShield
} from 'react-icons/fi';

const adminNavItems = [
  { path: '/', icon: FiHome, label: 'Dashboard' },
  { path: '/products', icon: FiPackage, label: 'Products' },
  { path: '/inventory', icon: FiClipboard, label: 'Inventory' },
  { path: '/sales', icon: FiShoppingCart, label: 'Sales' },
  { path: '/expenses', icon: FiDollarSign, label: 'Expenses' },
  { path: '/credit', icon: FiCreditCard, label: 'Credit' },
  { path: '/customers', icon: FiUsers, label: 'Customers' },
  { path: '/shipping', icon: FiTruck, label: 'Shipping' },
  { path: '/reports', icon: FiBarChart2, label: 'Reports' },
  { path: '/settings', icon: FiSettings, label: 'Settings' },
];

const superadminNavItems = [
  { path: '/superadmin', icon: FiShield, label: 'Admin Panel' },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const navItems = user?.role === 'superadmin' ? superadminNavItems : adminNavItems;

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <aside className={`fixed inset-y-0 left-0 z-50 w-64 bg-gray-900 text-white transform transition-transform lg:relative lg:translate-x-0 flex flex-col ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <div>
            <h1 className="text-xl font-bold text-white">BizTrack</h1>
            {user?.role === 'superadmin'
            ? <p className="text-xs text-gray-400">System Admin</p>
            : user?.companyName && <p className="text-xs text-gray-400 truncate">{user.companyName}</p>}
          </div>
          <button className="lg:hidden text-gray-400 hover:text-white" onClick={() => setSidebarOpen(false)}>
            <FiX size={20} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto p-4 space-y-1">
          {navItems.map(item => {
            const isActive = location.pathname === item.path ||
              (item.path !== '/' && location.pathname.startsWith(item.path));
            return (
              <Link
                key={item.path}
                to={item.path}
                onClick={() => setSidebarOpen(false)}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                }`}
              >
                <item.icon size={18} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-gray-700">
          <div className="text-sm text-gray-400 mb-2">{user?.name}</div>
          <button
            onClick={logout}
            className="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors"
          >
            <FiLogOut size={16} />
            Logout
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between lg:px-6">
          <button className="lg:hidden text-gray-600" onClick={() => setSidebarOpen(true)}>
            <FiMenu size={24} />
          </button>
          <div className="text-lg font-semibold text-gray-800 hidden lg:block">
            {navItems.find(i => i.path === location.pathname || (i.path !== '/' && location.pathname.startsWith(i.path)))?.label || 'BizTrack'}
          </div>
          <div className="text-sm text-gray-500">{user?.name}</div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-auto p-4 lg:p-6">
          <Outlet />
        </main>

        {/* Mobile bottom nav */}
        <nav className="lg:hidden fixed bottom-0 inset-x-0 bg-white border-t border-gray-200 flex justify-around py-2 z-30">
          {navItems.slice(0, 5).map(item => {
            const isActive = location.pathname === item.path ||
              (item.path !== '/' && location.pathname.startsWith(item.path));
            return (
              <Link
                key={item.path}
                to={item.path}
                className={`flex flex-col items-center gap-0.5 text-xs ${isActive ? 'text-blue-600' : 'text-gray-500'}`}
              >
                <item.icon size={20} />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
