import { useState, useEffect } from 'react';
import { getSettings, updateSettings } from '../services/api';
import LoadingSpinner from '../components/LoadingSpinner';
import toast from 'react-hot-toast';

export default function Settings() {
  const [settings, setSettings] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSettings().then(res => setSettings(res.data)).finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    try {
      const res = await updateSettings(settings);
      setSettings(res.data);
      toast.success('Settings saved');
    } catch { toast.error('Error saving settings'); }
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div className="max-w-lg space-y-6 pb-20 lg:pb-0">
      <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">Business Settings</h3>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Business Name</label>
            <input type="text" value={settings.businessName || ''}
              onChange={e => setSettings({...settings, businessName: e.target.value})}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
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
    </div>
  );
}
