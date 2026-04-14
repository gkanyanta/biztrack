import axios from 'axios';

const api = axios.create({
  baseURL: '/api/v1',
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('biztrack_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('biztrack_token');
      localStorage.removeItem('biztrack_user');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

// Auth
export const login = (data) => api.post('/auth/login', data);
export const register = (data) => api.post('/auth/register', data);
export const getMe = () => api.get('/auth/me');

// Products
export const getProducts = (params) => api.get('/products', { params });
export const getProduct = (id) => api.get(`/products/${id}`);
export const createProduct = (data) => api.post('/products', data);
export const updateProduct = (id, data) => api.put(`/products/${id}`, data);
export const deleteProduct = (id) => api.delete(`/products/${id}`);
export const bulkRestock = (items) => api.post('/products/restock', { items });
export const getStockLog = (id) => api.get(`/products/${id}/stock-log`);
export const getCategories = () => api.get('/products/meta/categories');

// Sales
export const getSales = (params) => api.get('/sales', { params });
export const getSale = (id) => api.get(`/sales/${id}`);
export const createSale = (data) => api.post('/sales', data);
export const updateSale = (id, data) => api.put(`/sales/${id}`, data);
export const updateSaleStatus = (id, status) => api.put(`/sales/${id}/status`, { status });
export const deleteSale = (id) => api.delete(`/sales/${id}`);
export const recordCreditPayment = (saleId, data) => api.post(`/sales/${saleId}/payments`, data);
export const getCreditPayments = (saleId) => api.get(`/sales/${saleId}/payments`);
export const getCreditSummary = () => api.get('/sales/credit/summary');
export const sendReminder = (saleId, data) => api.post(`/sales/${saleId}/reminders`, data);
export const getSaleReceipt = (id) => api.get(`/sales/${id}/receipt`);

// Expenses
export const getExpenses = (params) => api.get('/expenses', { params });
export const createExpense = (data) => api.post('/expenses', data);
export const updateExpense = (id, data) => api.put(`/expenses/${id}`, data);
export const deleteExpense = (id) => api.delete(`/expenses/${id}`);

// Customers
export const getCustomers = (params) => api.get('/customers', { params });
export const getCustomer = (id) => api.get(`/customers/${id}`);
export const createCustomer = (data) => api.post('/customers', data);
export const updateCustomer = (id, data) => api.put(`/customers/${id}`, data);
export const deleteCustomer = (id) => api.delete(`/customers/${id}`);
export const getCustomerOrders = (id) => api.get(`/customers/${id}/orders`);

// Shipping Rates
export const getShippingRates = () => api.get('/shipping-rates');
export const createShippingRate = (data) => api.post('/shipping-rates', data);
export const updateShippingRate = (id, data) => api.put(`/shipping-rates/${id}`, data);
export const deleteShippingRate = (id) => api.delete(`/shipping-rates/${id}`);

// Dashboard & Reports
export const getDashboard = (params) => api.get('/dashboard', { params });
export const getGrowthReport = () => api.get('/reports/growth');
export const getPnlReport = (params) => api.get('/reports/pnl', { params });
export const getSalesReport = (params) => api.get('/reports/sales', { params });
export const getExpenseReport = (params) => api.get('/reports/expenses', { params });
export const getProductReport = (params) => api.get('/reports/products', { params });
export const getCustomerReport = (params) => api.get('/reports/customers', { params });
export const getCreditReport = () => api.get('/reports/credit');
export const getInventoryReport = () => api.get('/reports/inventory');
export const exportCSV = (type, params) => api.get('/reports/export/csv', {
  params: { type, ...params },
  responseType: type === 'pnl' ? 'blob' : 'text'
});

// Consultants
export const getConsultants = (params) => api.get('/consultants', { params });
export const getConsultant = (id) => api.get(`/consultants/${id}`);
export const createConsultant = (data) => api.post('/consultants', data);
export const updateConsultant = (id, data) => api.put(`/consultants/${id}`, data);
export const deleteConsultant = (id) => api.delete(`/consultants/${id}`);
export const getCommissionSummary = (params) => api.get('/consultants/commission-summary', { params });
export const recordCommissionPayment = (consultantId, data) => api.post(`/consultants/${consultantId}/payments`, data);
export const getCommissionPayments = (consultantId) => api.get(`/consultants/${consultantId}/payments`);
export const getConsultantStock = (consultantId) => api.get(`/consultants/${consultantId}/stock`);
export const transferStockToConsultant = (consultantId, data) => api.post(`/consultants/${consultantId}/stock/transfer`, data);
export const returnStockFromConsultant = (consultantId, data) => api.post(`/consultants/${consultantId}/stock/return`, data);
export const getStockTransfers = (consultantId) => api.get(`/consultants/${consultantId}/stock/transfers`);

// Store (public)
export const getStoreInfo = (slug) => api.get(`/store/${slug}/info`);
export const getStoreProducts = (slug, params) => api.get(`/store/${slug}/products`, { params });
export const placeStoreOrder = (slug, data) => api.post(`/store/${slug}/order`, data);
export const verifyStorePayment = (slug, data) => api.post(`/store/${slug}/verify-payment`, data);
export const getPaymentStatus = (slug, saleId) => api.get(`/store/${slug}/payment-status/${saleId}`);

// Inventory
export const getInventory = (params) => api.get('/inventory', { params });

// Superadmin
export const getSuperadminStats = () => api.get('/superadmin/stats');
export const getCompanies = () => api.get('/superadmin/companies');
export const getCompanyDetail = (id) => api.get(`/superadmin/companies/${id}`);
export const createCompanyAdmin = (data) => api.post('/superadmin/companies', data);
export const updateCompany = (id, data) => api.put(`/superadmin/companies/${id}`, data);
export const toggleCompanyStatus = (id) => api.put(`/superadmin/companies/${id}/toggle-status`);
export const deleteCompany = (id) => api.delete(`/superadmin/companies/${id}`);
export const uploadCompanyLogo = (id, logo) => api.put(`/superadmin/companies/${id}/logo`, { logo });
export const addCompanyUser = (id, data) => api.post(`/superadmin/companies/${id}/users`, data);
export const resetAdminPassword = (userId, data) => api.post(`/superadmin/users/${userId}/reset-password`, data);

// Settings
export const getSettings = () => api.get('/settings');
export const updateSettings = (data) => api.put('/settings', data);

export default api;
