import { useState, useEffect, useRef } from 'react';
import { getSettings, updateSettings } from '../services/api';
import LoadingSpinner from '../components/LoadingSpinner';
import toast from 'react-hot-toast';
import { FiUpload, FiTrash2 } from 'react-icons/fi';

export default function Settings() {
  const [settings, setSettings] = useState({});
  const [loading, setLoading] = useState(true);
  const fileInputRef = useRef(null);

  useEffect(() => {
    getSettings().then(res => setSettings(res.data)).finally(() => setLoading(false));
  }, []);

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
    </div>
  );
}
