import { useState, useEffect, useRef } from 'react';
import {
  getSuperadminStats, getCompanies, getCompanyDetail, createCompanyAdmin,
  updateCompany, toggleCompanyStatus, deleteCompany, uploadCompanyLogo,
  addCompanyUser, resetAdminPassword
} from '../services/api';
import Modal from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';
import toast from 'react-hot-toast';
import {
  FiUsers, FiBriefcase, FiPlus, FiKey, FiChevronDown, FiChevronUp,
  FiEye, FiDollarSign, FiShoppingCart, FiTrendingUp, FiUpload, FiTrash2,
  FiEdit2, FiToggleLeft, FiToggleRight, FiUserPlus, FiImage
} from 'react-icons/fi';

function formatDate(date) {
  if (!date) return '';
  return new Date(date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatMoney(amount) {
  const num = parseFloat(amount) || 0;
  return `K${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function SuperadminPanel() {
  const [stats, setStats] = useState(null);
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedCompany, setExpandedCompany] = useState(null);
  const [companyDetail, setCompanyDetail] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // Modals
  const [showCreate, setShowCreate] = useState(false);
  const [showReset, setShowReset] = useState(null);
  const [showEdit, setShowEdit] = useState(null);
  const [showAddUser, setShowAddUser] = useState(null);
  const [showDelete, setShowDelete] = useState(null);
  const [showLogo, setShowLogo] = useState(null);

  // Forms
  const [createForm, setCreateForm] = useState({ companyName: '', username: '', password: '', name: '' });
  const [resetForm, setResetForm] = useState({ newPassword: '' });
  const [editForm, setEditForm] = useState({ name: '' });
  const [addUserForm, setAddUserForm] = useState({ username: '', password: '', name: '' });
  const [logoPreview, setLogoPreview] = useState(null);
  const logoInputRef = useRef(null);

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
    } finally { setSubmitting(false); }
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
    } finally { setSubmitting(false); }
  };

  const handleEdit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await updateCompany(showEdit.id, editForm);
      toast.success('Company updated');
      setShowEdit(null);
      loadData();
      if (expandedCompany === showEdit.id) toggleCompany(showEdit.id);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update');
    } finally { setSubmitting(false); }
  };

  const handleToggleStatus = async (company) => {
    try {
      await toggleCompanyStatus(company.id);
      toast.success(`${company.name} ${company.isActive ? 'suspended' : 'activated'}`);
      loadData();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to toggle status');
    }
  };

  const handleDelete = async () => {
    setSubmitting(true);
    try {
      await deleteCompany(showDelete.id);
      toast.success(`${showDelete.name} deleted`);
      setShowDelete(null);
      setExpandedCompany(null);
      setCompanyDetail(null);
      loadData();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to delete');
    } finally { setSubmitting(false); }
  };

  const handleAddUser = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await addCompanyUser(showAddUser.id, addUserForm);
      toast.success('User added');
      setShowAddUser(null);
      setAddUserForm({ username: '', password: '', name: '' });
      if (expandedCompany) toggleCompany(expandedCompany);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to add user');
    } finally { setSubmitting(false); }
  };

  const handleLogoSelect = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast.error('Select an image file'); return; }
    if (file.size > 500 * 1024) { toast.error('Logo must be under 500KB'); return; }
    const reader = new FileReader();
    reader.onload = () => setLogoPreview(reader.result);
    reader.readAsDataURL(file);
  };

  const handleLogoUpload = async () => {
    setSubmitting(true);
    try {
      await uploadCompanyLogo(showLogo.id, logoPreview || '');
      toast.success(logoPreview ? 'Logo uploaded' : 'Logo removed');
      setShowLogo(null);
      setLogoPreview(null);
      if (expandedCompany) toggleCompany(expandedCompany);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to upload logo');
    } finally { setSubmitting(false); }
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

      {/* Platform Stats */}
      {stats && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard icon={FiBriefcase} label="Companies" value={stats.totalCompanies} sub={`${stats.activeCompanies} active`} color="blue" />
            <StatCard icon={FiUsers} label="Admin Users" value={stats.totalUsers} color="green" />
            <StatCard icon={FiDollarSign} label="Platform Revenue" value={formatMoney(stats.totalRevenue)} color="purple" />
            <StatCard icon={FiShoppingCart} label="Total Orders" value={stats.totalOrders} sub={`COGS: ${formatMoney(stats.totalCOGS)}`} color="orange" />
          </div>

          {stats.topCompanies?.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                <FiTrendingUp className="text-purple-500" /> Top Companies by Revenue
              </h3>
              <div className="space-y-2">
                {stats.topCompanies.map((c, i) => (
                  <div key={c.id} className="flex items-center justify-between text-sm py-2 border-b border-gray-50 last:border-0">
                    <div className="flex items-center gap-3">
                      <span className="text-gray-400 font-medium w-6">#{i + 1}</span>
                      <span className="font-medium text-gray-800">{c.name}</span>
                      <span className="text-gray-400 text-xs">{c.orders} orders</span>
                    </div>
                    <span className="font-semibold text-green-600">{formatMoney(c.revenue)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Companies Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200">
          <h3 className="text-sm font-semibold text-gray-700">All Companies</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-4 py-3 font-medium text-gray-600">Company</th>
                <th className="text-center px-4 py-3 font-medium text-gray-600">Status</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Users</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600 hidden sm:table-cell">Products</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600 hidden sm:table-cell">Sales</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 hidden md:table-cell">Created</th>
                <th className="text-center px-4 py-3 font-medium text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {companies.length === 0 ? (
                <tr><td colSpan={7} className="text-center py-8 text-gray-400">No companies yet</td></tr>
              ) : companies.map(c => (
                <>
                  <tr key={c.id} className={`hover:bg-gray-50 ${!c.isActive ? 'opacity-60' : ''}`}>
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-800">{c.name}</div>
                      <div className="text-xs text-gray-400">{c.slug}</div>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${c.isActive ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                        {c.isActive ? 'Active' : 'Suspended'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700">{c._count.users}</td>
                    <td className="px-4 py-3 text-right text-gray-700 hidden sm:table-cell">{c._count.products}</td>
                    <td className="px-4 py-3 text-right text-gray-700 hidden sm:table-cell">{c._count.sales}</td>
                    <td className="px-4 py-3 text-gray-500 hidden md:table-cell">{formatDate(c.createdAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-center gap-1">
                        <button onClick={() => toggleCompany(c.id)} title="View details"
                          className="p-1.5 text-blue-600 hover:bg-blue-50 rounded">
                          {expandedCompany === c.id ? <FiChevronUp size={14} /> : <FiEye size={14} />}
                        </button>
                        <button onClick={() => { setShowEdit(c); setEditForm({ name: c.name }); }} title="Edit"
                          className="p-1.5 text-gray-500 hover:bg-gray-100 rounded">
                          <FiEdit2 size={14} />
                        </button>
                        <button onClick={() => handleToggleStatus(c)} title={c.isActive ? 'Suspend' : 'Activate'}
                          className={`p-1.5 rounded ${c.isActive ? 'text-amber-600 hover:bg-amber-50' : 'text-green-600 hover:bg-green-50'}`}>
                          {c.isActive ? <FiToggleRight size={14} /> : <FiToggleLeft size={14} />}
                        </button>
                        <button onClick={() => setShowDelete(c)} title="Delete"
                          className="p-1.5 text-red-500 hover:bg-red-50 rounded">
                          <FiTrash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                  {expandedCompany === c.id && companyDetail && (
                    <tr key={`${c.id}-detail`}>
                      <td colSpan={7} className="bg-gray-50 px-4 py-4">
                        {/* Company Metrics */}
                        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4">
                          <MiniStat label="Revenue" value={formatMoney(companyDetail.metrics.revenue)} />
                          <MiniStat label="COGS" value={formatMoney(companyDetail.metrics.cogs)} />
                          <MiniStat label="Gross Profit" value={formatMoney(companyDetail.metrics.grossProfit)} />
                          <MiniStat label="Expenses" value={formatMoney(companyDetail.metrics.totalExpenses)} />
                          <MiniStat label="Net Profit" value={formatMoney(companyDetail.metrics.netProfit)} highlight />
                        </div>

                        {/* Logo + Actions */}
                        <div className="flex items-center gap-3 mb-4">
                          {companyDetail.settings?.companyLogo ? (
                            <img src={companyDetail.settings.companyLogo} alt="Logo" className="h-12 w-12 object-contain rounded border bg-white p-0.5" />
                          ) : (
                            <div className="h-12 w-12 rounded border bg-white flex items-center justify-center text-gray-300"><FiImage size={20} /></div>
                          )}
                          <button onClick={() => { setShowLogo(c); setLogoPreview(companyDetail.settings?.companyLogo || null); }}
                            className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800">
                            <FiUpload size={14} /> {companyDetail.settings?.companyLogo ? 'Change Logo' : 'Upload Logo'}
                          </button>
                          <button onClick={() => { setShowAddUser(c); setAddUserForm({ username: '', password: '', name: '' }); }}
                            className="flex items-center gap-1 text-sm text-green-600 hover:text-green-800 ml-auto">
                            <FiUserPlus size={14} /> Add User
                          </button>
                        </div>

                        {/* Users */}
                        <h4 className="text-sm font-semibold text-gray-700 mb-2">Admin Users</h4>
                        <div className="space-y-2 mb-4">
                          {companyDetail.users.map(u => (
                            <div key={u.id} className="flex items-center justify-between bg-white rounded-lg px-3 py-2 border border-gray-200">
                              <div>
                                <span className="font-medium text-gray-800">{u.name}</span>
                                <span className="text-gray-400 ml-2 text-xs">@{u.username}</span>
                              </div>
                              <button onClick={() => { setShowReset(u); setResetForm({ newPassword: '' }); }}
                                className="flex items-center gap-1 text-sm text-amber-600 hover:text-amber-800">
                                <FiKey size={14} /> Reset Password
                              </button>
                            </div>
                          ))}
                        </div>

                        {/* Data Counts */}
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                          <MiniStat label="Products" value={companyDetail._count.products} small />
                          <MiniStat label="Orders" value={companyDetail.metrics.totalOrders} small />
                          <MiniStat label="Customers" value={companyDetail._count.customers} small />
                          <MiniStat label="Expenses" value={companyDetail._count.expenses} small />
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
          <FormInput label="Company Name" required value={createForm.companyName} onChange={v => setCreateForm({ ...createForm, companyName: v })} />
          <FormInput label="Admin Name" required value={createForm.name} onChange={v => setCreateForm({ ...createForm, name: v })} />
          <FormInput label="Username" required value={createForm.username} onChange={v => setCreateForm({ ...createForm, username: v })} />
          <FormInput label="Password" type="password" required minLength={6} value={createForm.password} onChange={v => setCreateForm({ ...createForm, password: v })} />
          <SubmitBtn loading={submitting} text="Create Company & Admin" />
        </form>
      </Modal>

      {/* Edit Company Modal */}
      <Modal isOpen={!!showEdit} onClose={() => setShowEdit(null)} title={`Edit — ${showEdit?.name || ''}`}>
        <form onSubmit={handleEdit} className="space-y-4">
          <FormInput label="Company Name" required value={editForm.name} onChange={v => setEditForm({ ...editForm, name: v })} />
          <SubmitBtn loading={submitting} text="Save Changes" />
        </form>
      </Modal>

      {/* Reset Password Modal */}
      <Modal isOpen={!!showReset} onClose={() => setShowReset(null)} title={`Reset Password — ${showReset?.name || ''}`}>
        <form onSubmit={handleReset} className="space-y-4">
          <p className="text-sm text-gray-500">Set a new password for <strong>{showReset?.name}</strong> (@{showReset?.username}).</p>
          <FormInput label="New Password" type="password" required minLength={6} value={resetForm.newPassword} onChange={v => setResetForm({ newPassword: v })} />
          <SubmitBtn loading={submitting} text="Reset Password" color="amber" />
        </form>
      </Modal>

      {/* Add User Modal */}
      <Modal isOpen={!!showAddUser} onClose={() => setShowAddUser(null)} title={`Add User — ${showAddUser?.name || ''}`}>
        <form onSubmit={handleAddUser} className="space-y-4">
          <FormInput label="Full Name" required value={addUserForm.name} onChange={v => setAddUserForm({ ...addUserForm, name: v })} />
          <FormInput label="Username" required value={addUserForm.username} onChange={v => setAddUserForm({ ...addUserForm, username: v })} />
          <FormInput label="Password" type="password" required minLength={6} value={addUserForm.password} onChange={v => setAddUserForm({ ...addUserForm, password: v })} />
          <SubmitBtn loading={submitting} text="Add User" color="green" />
        </form>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal isOpen={!!showDelete} onClose={() => setShowDelete(null)} title="Delete Company">
        <div className="space-y-4">
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <p className="text-sm text-red-800 font-medium">This will permanently delete:</p>
            <ul className="text-sm text-red-700 mt-2 space-y-1 list-disc list-inside">
              <li><strong>{showDelete?.name}</strong> and all its data</li>
              <li>All products, sales, customers, expenses</li>
              <li>All admin users for this company</li>
            </ul>
            <p className="text-sm text-red-800 font-bold mt-3">This action cannot be undone.</p>
          </div>
          <div className="flex gap-3">
            <button onClick={() => setShowDelete(null)} className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50">
              Cancel
            </button>
            <button onClick={handleDelete} disabled={submitting}
              className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg text-sm hover:bg-red-700 disabled:opacity-50">
              {submitting ? 'Deleting...' : 'Delete Forever'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Logo Upload Modal */}
      <Modal isOpen={!!showLogo} onClose={() => { setShowLogo(null); setLogoPreview(null); }} title={`Logo — ${showLogo?.name || ''}`}>
        <div className="space-y-4">
          {logoPreview ? (
            <div className="flex items-start gap-4">
              <img src={logoPreview} alt="Preview" className="h-24 w-24 object-contain rounded-lg border bg-gray-50 p-1" />
              <div className="flex flex-col gap-2">
                <button onClick={() => logoInputRef.current?.click()} className="text-sm text-blue-600 hover:text-blue-800 flex items-center gap-1">
                  <FiUpload size={14} /> Change
                </button>
                <button onClick={() => setLogoPreview(null)} className="text-sm text-red-600 hover:text-red-800 flex items-center gap-1">
                  <FiTrash2 size={14} /> Remove
                </button>
              </div>
            </div>
          ) : (
            <button onClick={() => logoInputRef.current?.click()}
              className="flex items-center gap-2 px-4 py-6 border-2 border-dashed border-gray-300 rounded-lg text-sm text-gray-500 hover:border-blue-400 hover:text-blue-600 w-full justify-center">
              <FiUpload size={16} /> Select Logo (max 500KB)
            </button>
          )}
          <input ref={logoInputRef} type="file" accept="image/*" onChange={handleLogoSelect} className="hidden" />
          <button onClick={handleLogoUpload} disabled={submitting}
            className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">
            {submitting ? 'Saving...' : logoPreview ? 'Save Logo' : 'Remove Logo'}
          </button>
        </div>
      </Modal>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, sub, color }) {
  const colors = { blue: 'bg-blue-50 text-blue-600', green: 'bg-green-50 text-green-600', purple: 'bg-purple-50 text-purple-600', orange: 'bg-orange-50 text-orange-600' };
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="flex items-center gap-3 mb-2">
        <div className={`p-2 rounded-lg ${colors[color]}`}><Icon size={18} /></div>
        <span className="text-sm text-gray-500">{label}</span>
      </div>
      <p className="text-xl font-bold text-gray-800">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </div>
  );
}

function MiniStat({ label, value, highlight, small }) {
  return (
    <div className={`bg-white rounded-lg px-3 py-2 border ${highlight ? 'border-green-200 bg-green-50' : 'border-gray-200'}`}>
      <span className="text-gray-400 text-xs">{label}</span>
      <p className={`font-semibold ${highlight ? 'text-green-700' : 'text-gray-800'} ${small ? 'text-sm' : ''}`}>{value}</p>
    </div>
  );
}

function FormInput({ label, type = 'text', required, minLength, value, onChange }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input type={type} required={required} minLength={minLength} value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
    </div>
  );
}

function SubmitBtn({ loading, text, color = 'blue' }) {
  const colors = { blue: 'bg-blue-600 hover:bg-blue-700', amber: 'bg-amber-600 hover:bg-amber-700', green: 'bg-green-600 hover:bg-green-700' };
  return (
    <button type="submit" disabled={loading}
      className={`w-full px-4 py-2 text-white rounded-lg text-sm disabled:opacity-50 ${colors[color]}`}>
      {loading ? 'Please wait...' : text}
    </button>
  );
}
