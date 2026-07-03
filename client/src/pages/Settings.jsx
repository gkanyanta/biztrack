import { useState, useEffect, useRef } from 'react';
import { getSettings, updateSettings, getStockLocations, createStockLocation, getStaff, createStaff, resetStaffPassword, deleteStaff } from '../services/api';
import LoadingSpinner from '../components/LoadingSpinner';
import ConfirmDialog from '../components/ConfirmDialog';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { FiUpload, FiTrash2, FiTruck, FiPlus, FiKey, FiUsers } from 'react-icons/fi';

export default function Settings() {
  const [settings, setSettings] = useState({});
  const [loading, setLoading] = useState(true);
  const fileInputRef = useRef(null);

  const [locations, setLocations] = useState([]);
  const [creatingLocation, setCreatingLocation] = useState(false);

  const [staff, setStaff] = useState([]);
  const [showStaffForm, setShowStaffForm] = useState(false);
  const [staffForm, setStaffForm] = useState({ name: '', username: '', password: '' });
  const [resetTarget, setResetTarget] = useState(null);
  const [resetPassword, setResetPassword] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);

  const loadStockLocations = () => getStockLocations().then(res => setLocations(res.data)).catch(() => {});
  const loadStaff = () => getStaff().then(res => setStaff(res.data)).catch(() => {});

  useEffect(() => {
    getSettings().then(res => setSettings(res.data)).finally(() => setLoading(false));
    loadStockLocations();
    loadStaff();
  }, []);

  const handleCreateCarStock = async () => {
    setCreatingLocation(true);
    try {
      await createStockLocation({ name: 'My Car' });
      toast.success('Car stock tracking enabled');
      loadStockLocations();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Error setting up car stock');
    } finally { setCreatingLocation(false); }
  };

  const handleCreateStaff = async (e) => {
    e.preventDefault();
    try {
      await createStaff({ ...staffForm, role: 'inventory' });
      toast.success('Warehouse staff account created');
      setShowStaffForm(false);
      setStaffForm({ name: '', username: '', password: '' });
      loadStaff();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Error creating staff account');
    }
  };

  const handleResetPassword = async (e) => {
    e.preventDefault();
    try {
      await resetStaffPassword(resetTarget.id, { password: resetPassword });
      toast.success('Password reset');
      setResetTarget(null);
      setResetPassword('');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Error resetting password');
    }
  };

  const handleDeleteStaff = async () => {
    try {
      await deleteStaff(deleteTarget.id);
      toast.success('Staff account removed');
      setDeleteTarget(null);
      loadStaff();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Error removing staff account');
    }
  };

  const [logoChanged, setLogoChanged] = useState(false);

  const handleSave = async () => {
    try {
      // Save text settings (exclude logo to avoid payload size issues)
      const { companyLogo, ...textSettings } = settings;
      await updateSettings(textSettings);
      // Save logo separately only if it changed
      if (logoChanged) {
        await updateSettings({ companyLogo: companyLogo || '' });
        setLogoChanged(false);
      }
      toast.success('Settings saved');
    } catch { toast.error('Error saving settings'); }
  };

  const handleLogoUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Please select an image file');
      return;
    }
    if (file.size > 500 * 1024) {
      toast.error('Logo must be under 500KB');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setSettings({ ...settings, companyLogo: reader.result });
      setLogoChanged(true);
    };
    reader.readAsDataURL(file);
  };

  const removeLogo = () => {
    setSettings({ ...settings, companyLogo: '' });
    setLogoChanged(true);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div className="max-w-lg space-y-6 pb-20 lg:pb-0">
      <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">Business Settings</h3>
        <div className="space-y-4">
          {/* Company Logo */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Company Logo</label>
            {settings.companyLogo ? (
              <div className="flex items-start gap-4">
                <img src={settings.companyLogo} alt="Company logo" className="h-20 w-20 object-contain rounded-lg border border-gray-200 bg-gray-50 p-1" />
                <div className="flex flex-col gap-2">
                  <button onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800">
                    <FiUpload size={14} /> Change
                  </button>
                  <button onClick={removeLogo}
                    className="inline-flex items-center gap-1 text-sm text-red-600 hover:text-red-800">
                    <FiTrash2 size={14} /> Remove
                  </button>
                </div>
              </div>
            ) : (
              <button onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-2 px-4 py-3 border-2 border-dashed border-gray-300 rounded-lg text-sm text-gray-500 hover:border-blue-400 hover:text-blue-600 transition-colors w-full justify-center">
                <FiUpload size={16} /> Upload Logo (max 500KB)
              </button>
            )}
            <input ref={fileInputRef} type="file" accept="image/*" onChange={handleLogoUpload} className="hidden" />
            <p className="text-xs text-gray-400 mt-1">Appears on receipts and invoices. PNG or JPG recommended.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Business Name</label>
            <input type="text" value={settings.businessName || ''}
              onChange={e => setSettings({...settings, businessName: e.target.value})}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Company Address</label>
            <textarea value={settings.companyAddress || ''}
              onChange={e => setSettings({...settings, companyAddress: e.target.value})}
              rows={2}
              placeholder="e.g. Plot 123, Cairo Road, Lusaka"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">TPIN Number</label>
            <input type="text" value={settings.companyTpin || ''}
              onChange={e => setSettings({...settings, companyTpin: e.target.value})}
              placeholder="e.g. 1234567890"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Phone Number</label>
            <input type="text" value={settings.companyPhone || ''}
              onChange={e => setSettings({...settings, companyPhone: e.target.value})}
              placeholder="e.g. +260 97 1234567"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email Address</label>
            <input type="email" value={settings.companyEmail || ''}
              onChange={e => setSettings({...settings, companyEmail: e.target.value})}
              placeholder="e.g. info@company.com"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Website</label>
            <input type="text" value={settings.companyWebsite || ''}
              onChange={e => setSettings({...settings, companyWebsite: e.target.value})}
              placeholder="e.g. www.company.com"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="border-t border-gray-200 pt-4 mt-2">
            <h4 className="text-sm font-medium text-gray-500 mb-3">Currency</h4>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Currency Code</label>
            <input type="text" value={settings.currency || ''}
              onChange={e => setSettings({...settings, currency: e.target.value})}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Currency Symbol</label>
            <input type="text" value={settings.currencySymbol || ''}
              onChange={e => setSettings({...settings, currencySymbol: e.target.value})}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <button onClick={handleSave}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
            Save Settings
          </button>
        </div>
      </div>

      {/* Payment Gateway */}
      <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
        <h3 className="text-sm font-semibold text-gray-700 mb-1">Online Payment (Lenco)</h3>
        <p className="text-xs text-gray-400 mb-4">Enable customers to pay online via Visa, Mastercard, MTN Mobile Money, or Airtel Money</p>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Lenco Public Key</label>
            <input type="text" value={settings.lencoPublicKey || ''}
              onChange={e => setSettings({...settings, lencoPublicKey: e.target.value})}
              placeholder="pub-xxxxxxxxxxxxxxxx"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 font-mono" />
            <p className="text-xs text-gray-400 mt-1">Get this from your Lenco app under Collections / Lenco Pay.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Lenco Secret Key</label>
            <input type="password" value={settings.lencoSecretKey || ''}
              onChange={e => setSettings({...settings, lencoSecretKey: e.target.value})}
              placeholder="Enter your Lenco API secret key"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 font-mono" />
            <p className="text-xs text-gray-400 mt-1">Used for server-side payment verification. Never shared publicly.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Store Welcome Message</label>
            <input type="text" value={settings.storeMessage || ''}
              onChange={e => setSettings({...settings, storeMessage: e.target.value})}
              placeholder="e.g. Free delivery on orders over K500!"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <button onClick={handleSave}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
            Save Settings
          </button>
        </div>
      </div>

      {/* Car Stock Tracking */}
      <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
        <h3 className="text-sm font-semibold text-gray-700 mb-1 flex items-center gap-2"><FiTruck size={16} /> Car Stock Tracking</h3>
        <p className="text-xs text-gray-400 mb-4">Tracks stock dispatched to your car separately from warehouse stock, so sales made directly from the car deduct from the right pool.</p>
        {locations.length === 0 ? (
          <button onClick={handleCreateCarStock} disabled={creatingLocation}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
            <FiPlus size={14} /> {creatingLocation ? 'Setting up...' : 'Enable Car Stock Tracking'}
          </button>
        ) : (
          <div className="space-y-1">
            {locations.map(l => (
              <div key={l.id} className="text-sm text-gray-700 bg-gray-50 rounded-lg px-3 py-2">{l.name}</div>
            ))}
            <p className="text-xs text-gray-400 mt-2">Selectable as a "Stock from" source when recording a sale, and as a dispatch target from the Warehouse page.</p>
          </div>
        )}
      </div>

      {/* Warehouse Staff Accounts */}
      <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2"><FiUsers size={16} /> Warehouse Staff</h3>
          <button onClick={() => setShowStaffForm(true)} className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800">
            <FiPlus size={14} /> Add Staff
          </button>
        </div>
        <p className="text-xs text-gray-400 mb-4">Logins with warehouse-only access — stock in, dispatch to your car, and marking orders dispatched. No pricing, financials, or other admin pages.</p>
        <div className="space-y-2">
          {staff.map(s => (
            <div key={s.id} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2">
              <div>
                <div className="text-sm font-medium text-gray-800">{s.name}</div>
                <div className="text-xs text-gray-400">@{s.username}</div>
              </div>
              <div className="flex gap-1">
                <button onClick={() => setResetTarget(s)} title="Reset password" className="p-1.5 text-gray-400 hover:text-blue-600"><FiKey size={15} /></button>
                <button onClick={() => setDeleteTarget(s)} title="Remove account" className="p-1.5 text-gray-400 hover:text-red-600"><FiTrash2 size={15} /></button>
              </div>
            </div>
          ))}
          {staff.length === 0 && <p className="text-sm text-gray-400 text-center py-4">No warehouse staff accounts yet.</p>}
        </div>
      </div>

      <Modal isOpen={showStaffForm} onClose={() => setShowStaffForm(false)} title="Add Warehouse Staff" size="sm">
        <form onSubmit={handleCreateStaff} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
            <input type="text" required value={staffForm.name} onChange={e => setStaffForm({...staffForm, name: e.target.value})}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Username</label>
            <input type="text" required value={staffForm.username} onChange={e => setStaffForm({...staffForm, username: e.target.value})}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
            <input type="password" required minLength={6} value={staffForm.password} onChange={e => setStaffForm({...staffForm, password: e.target.value})}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="flex gap-3 justify-end pt-2">
            <button type="button" onClick={() => setShowStaffForm(false)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
            <button type="submit" className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">Create</button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={!!resetTarget} onClose={() => { setResetTarget(null); setResetPassword(''); }} title={`Reset Password — ${resetTarget?.name}`} size="sm">
        <form onSubmit={handleResetPassword} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">New Password</label>
            <input type="password" required minLength={6} value={resetPassword} onChange={e => setResetPassword(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="flex gap-3 justify-end pt-2">
            <button type="button" onClick={() => { setResetTarget(null); setResetPassword(''); }} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
            <button type="submit" className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">Reset</button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog isOpen={!!deleteTarget} onClose={() => setDeleteTarget(null)} onConfirm={handleDeleteStaff}
        title="Remove Staff Account" message={`Remove login access for "${deleteTarget?.name}"?`} />
    </div>
  );
}
