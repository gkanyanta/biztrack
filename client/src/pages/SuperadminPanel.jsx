import { useState, useEffect } from 'react';
import { getSuperadminStats, getCompanies, getCompanyDetail, createCompanyAdmin, resetAdminPassword } from '../services/api';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';
import toast from 'react-hot-toast';
import { FiUsers, FiBriefcase, FiPlus, FiKey, FiChevronDown, FiChevronUp, FiEye } from 'react-icons/fi';

function formatDate(date) {
  if (!date) return '';
  return new Date(date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function SuperadminPanel() {
  const [stats, setStats] = useState(null);
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showReset, setShowReset] = useState(null);
  const [expandedCompany, setExpandedCompany] = useState(null);
  const [companyDetail, setCompanyDetail] = useState(null);
  const [createForm, setCreateForm] = useState({ companyName: '', username: '', password: '', name: '' });
  const [resetForm, setResetForm] = useState({ newPassword: '' });
  const [submitting, setSubmitting] = useState(false);

  const loadData = async () => {
    try {
      const [statsRes, companiesRes] = await Promise.all([getSuperadminStats(), getCompanies()]);
      setStats(statsRes.data);
      setCompanies(companiesRes.data);
    } catch {
      toast.error('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  const toggleCompany = async (id) => {
    if (expandedCompany === id) {
      setExpandedCompany(null);
      setCompanyDetail(null);
      return;
    }
    try {
      const { data } = await getCompanyDetail(id);
      setCompanyDetail(data);
      setExpandedCompany(id);
    } catch {
      toast.error('Failed to load company details');
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await createCompanyAdmin(createForm);
      toast.success('Company and admin created');
      setShowCreate(false);
      setCreateForm({ companyName: '', username: '', password: '', name: '' });
      loadData();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to create');
    } finally {
      setSubmitting(false);
    }
  };

  const handleReset = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await resetAdminPassword(showReset.id, resetForm);
      toast.success(`Password reset for ${showReset.name}`);
      setShowReset(null);
      setResetForm({ newPassword: '' });
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to reset password');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div className="space-y-6 pb-20 lg:pb-0">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-800">System Admin</h1>
        <button onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">
          <FiPlus size={16} /> New Company
        </button>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 rounded-lg bg-blue-50 text-blue-600"><FiBriefcase size={18} /></div>
              <span className="text-sm text-gray-500">Total Companies</span>
            </div>
            <p className="text-2xl font-bold text-gray-800">{stats.totalCompanies}</p>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 rounded-lg bg-green-50 text-green-600"><FiUsers size={18} /></div>
              <span className="text-sm text-gray-500">Total Admin Users</span>
            </div>
            <p className="text-2xl font-bold text-gray-800">{stats.totalUsers}</p>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 rounded-lg bg-purple-50 text-purple-600"><FiBriefcase size={18} /></div>
              <span className="text-sm text-gray-500">Newest Company</span>
            </div>
            <p className="text-lg font-bold text-gray-800">{stats.newestCompany?.name || 'None'}</p>
            <p className="text-xs text-gray-400">{formatDate(stats.newestCompany?.createdAt)}</p>
          </div>
        </div>
      )}

      {/* Companies Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200">
          <h3 className="text-sm font-semibold text-gray-700">Companies</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-4 py-3 font-medium text-gray-600">Company</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Users</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600 hidden sm:table-cell">Products</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600 hidden sm:table-cell">Sales</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 hidden md:table-cell">Created</th>
                <th className="text-center px-4 py-3 font-medium text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {companies.length === 0 ? (
                <tr><td colSpan={6} className="text-center py-8 text-gray-400">No companies yet</td></tr>
              ) : companies.map(c => (
                <>
                  <tr key={c.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-800">{c.name}</div>
                      <div className="text-xs text-gray-400">{c.slug}</div>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700">{c._count.users}</td>
                    <td className="px-4 py-3 text-right text-gray-700 hidden sm:table-cell">{c._count.products}</td>
                    <td className="px-4 py-3 text-right text-gray-700 hidden sm:table-cell">{c._count.sales}</td>
                    <td className="px-4 py-3 text-gray-500 hidden md:table-cell">{formatDate(c.createdAt)}</td>
                    <td className="px-4 py-3 text-center">
                      <button onClick={() => toggleCompany(c.id)}
                        className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-800 text-sm">
                        <FiEye size={14} />
                        {expandedCompany === c.id ? <FiChevronUp size={14} /> : <FiChevronDown size={14} />}
                      </button>
                    </td>
                  </tr>
                  {expandedCompany === c.id && companyDetail && (
                    <tr key={`${c.id}-detail`}>
                      <td colSpan={6} className="bg-gray-50 px-4 py-4">
                        <div className="mb-3">
                          <h4 className="text-sm font-semibold text-gray-700 mb-2">Admin Users</h4>
                          <div className="space-y-2">
                            {companyDetail.users.map(u => (
                              <div key={u.id} className="flex items-center justify-between bg-white rounded-lg px-3 py-2 border border-gray-200">
                                <div>
                                  <span className="font-medium text-gray-800">{u.name}</span>
                                  <span className="text-gray-400 ml-2 text-xs">@{u.username}</span>
                                  <span className="text-gray-400 ml-2 text-xs">({u.role})</span>
                                </div>
                                <button onClick={() => { setShowReset(u); setResetForm({ newPassword: '' }); }}
                                  className="flex items-center gap-1 text-sm text-amber-600 hover:text-amber-800">
                                  <FiKey size={14} /> Reset Password
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                          <div className="bg-white rounded-lg px-3 py-2 border border-gray-200">
                            <span className="text-gray-400">Products</span>
                            <p className="font-semibold text-gray-800">{companyDetail._count.products}</p>
                          </div>
                          <div className="bg-white rounded-lg px-3 py-2 border border-gray-200">
                            <span className="text-gray-400">Sales</span>
                            <p className="font-semibold text-gray-800">{companyDetail._count.sales}</p>
                          </div>
                          <div className="bg-white rounded-lg px-3 py-2 border border-gray-200">
                            <span className="text-gray-400">Customers</span>
                            <p className="font-semibold text-gray-800">{companyDetail._count.customers}</p>
                          </div>
                          <div className="bg-white rounded-lg px-3 py-2 border border-gray-200">
                            <span className="text-gray-400">Expenses</span>
                            <p className="font-semibold text-gray-800">{companyDetail._count.expenses}</p>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create Company Modal */}
      <Modal isOpen={showCreate} onClose={() => setShowCreate(false)} title="Create Company & Admin">
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Company Name</label>
            <input type="text" required value={createForm.companyName}
              onChange={e => setCreateForm({ ...createForm, companyName: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Admin Name</label>
            <input type="text" required value={createForm.name}
              onChange={e => setCreateForm({ ...createForm, name: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Username</label>
            <input type="text" required value={createForm.username}
              onChange={e => setCreateForm({ ...createForm, username: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
            <input type="password" required minLength={6} value={createForm.password}
              onChange={e => setCreateForm({ ...createForm, password: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <button type="submit" disabled={submitting}
            className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">
            {submitting ? 'Creating...' : 'Create Company & Admin'}
          </button>
        </form>
      </Modal>

      {/* Reset Password Modal */}
      <Modal isOpen={!!showReset} onClose={() => setShowReset(null)} title={`Reset Password — ${showReset?.name || ''}`}>
        <form onSubmit={handleReset} className="space-y-4">
          <p className="text-sm text-gray-500">
            Set a new password for <strong>{showReset?.name}</strong> (@{showReset?.username}).
          </p>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">New Password</label>
            <input type="password" required minLength={6} value={resetForm.newPassword}
              onChange={e => setResetForm({ newPassword: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            <p className="text-xs text-gray-400 mt-1">Minimum 6 characters</p>
          </div>
          <button type="submit" disabled={submitting}
            className="w-full px-4 py-2 bg-amber-600 text-white rounded-lg text-sm hover:bg-amber-700 disabled:opacity-50">
            {submitting ? 'Resetting...' : 'Reset Password'}
          </button>
        </form>
      </Modal>
    </div>
  );
}
