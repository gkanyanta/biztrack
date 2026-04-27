import { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { getStoreInfo, getStoreProducts, placeStoreOrder, verifyStorePayment, getPaymentStatus } from '../services/api';
import { FiShoppingCart, FiPlus, FiMinus, FiTrash2, FiX, FiPackage, FiCheck, FiPhone, FiMapPin, FiSearch, FiCreditCard, FiChevronRight, FiShield, FiTruck, FiZap } from 'react-icons/fi';

function formatMoney(amount, symbol = 'K') {
  const num = parseFloat(amount) || 0;
  return `${symbol}${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const DOMAIN_STORE_MAP = {
  'store.privtech.net': 'privtech-solutions',
};

export default function Store() {
  const { slug: paramSlug } = useParams();
  const [searchParams] = useSearchParams();
  const slug = paramSlug || DOMAIN_STORE_MAP[window.location.hostname] || '';
  const [store, setStore] = useState(null);
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [cart, setCart] = useState([]);
  const [showCart, setShowCart] = useState(false);
  const [showCheckout, setShowCheckout] = useState(false);
  const [orderResult, setOrderResult] = useState(null);
  const [paymentResult, setPaymentResult] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [payOnline, setPayOnline] = useState(false);
  const [checkoutForm, setCheckoutForm] = useState({ customerName: '', customerPhone: '', customerCity: '', deliveryAddress: '', notes: '' });
  // 'idle' | 'loading' | 'ready' | 'error'
  const [lencoSdkState, setLencoSdkState] = useState('idle');

  // Load Lenco SDK with explicit ready/error tracking
  useEffect(() => {
    if (typeof window.LencoPay !== 'undefined') { setLencoSdkState('ready'); return; }
    const existing = document.getElementById('lenco-sdk');
    if (existing) {
      // Another instance already injected the tag — wait for it
      setLencoSdkState('loading');
      const check = setInterval(() => {
        if (typeof window.LencoPay !== 'undefined') { setLencoSdkState('ready'); clearInterval(check); }
      }, 200);
      const fail = setTimeout(() => { clearInterval(check); if (typeof window.LencoPay === 'undefined') setLencoSdkState('error'); }, 15000);
      return () => { clearInterval(check); clearTimeout(fail); };
    }
    setLencoSdkState('loading');
    const script = document.createElement('script');
    script.id = 'lenco-sdk';
    script.src = 'https://pay.lenco.co/js/v1/inline.js';
    script.async = true;
    script.onload = () => setLencoSdkState(typeof window.LencoPay !== 'undefined' ? 'ready' : 'error');
    script.onerror = () => setLencoSdkState('error');
    document.head.appendChild(script);
  }, []);

  useEffect(() => {
    const orderId = searchParams.get('order');
    Promise.all([getStoreInfo(slug), getStoreProducts(slug)])
      .then(async ([infoRes, prodRes]) => {
        setStore(infoRes.data);
        setProducts(prodRes.data.products);
        setCategories(prodRes.data.categories);
        if (orderId) {
          try {
            const { data } = await getPaymentStatus(slug, orderId);
            setPaymentResult(data);
          } catch { setPaymentResult({ paymentStatus: 'Unknown', orderNumber: '' }); }
        }
      })
      .catch(err => setError(err.response?.status === 404 ? 'Store not found' : 'Failed to load store'))
      .finally(() => setLoading(false));
  }, [slug]);

  const loadProducts = (cat, q) => {
    getStoreProducts(slug, { category: cat || undefined, search: q || undefined })
      .then(res => setProducts(res.data.products));
  };

  const handleSearch = (q) => { setSearch(q); loadProducts(category, q); };
  const handleCategory = (cat) => { setCategory(cat); loadProducts(cat, search); };

  const addToCart = (product) => {
    setCart(prev => {
      const existing = prev.find(c => c.productId === product.id);
      if (existing) return prev.map(c => c.productId === product.id ? { ...c, qty: Math.min(c.qty + 1, product.stock) } : c);
      return [...prev, { productId: product.id, name: product.name, price: parseFloat(product.sellingPrice), qty: 1, stock: product.stock, imageUrl: product.imageUrl }];
    });
  };

  const updateQty = (productId, qty) => {
    if (qty <= 0) return removeFromCart(productId);
    setCart(prev => prev.map(c => c.productId === productId ? { ...c, qty: Math.min(qty, c.stock) } : c));
  };

  const removeFromCart = (productId) => setCart(prev => prev.filter(c => c.productId !== productId));

  const cartTotal = cart.reduce((sum, c) => sum + c.price * c.qty, 0);
  const cartCount = cart.reduce((sum, c) => sum + c.qty, 0);

  const buyNow = (product) => {
    setCart([{ productId: product.id, name: product.name, price: parseFloat(product.sellingPrice), qty: 1, stock: product.stock, imageUrl: product.imageUrl }]);
    setShowCheckout(true);
  };

  // Wait for the Lenco SDK to finish loading. Resolves true if ready, false on timeout/error.
  const waitForLencoSdk = (timeoutMs = 8000) => new Promise(resolve => {
    if (typeof window.LencoPay !== 'undefined') return resolve(true);
    if (lencoSdkState === 'error') return resolve(false);
    const start = Date.now();
    const check = setInterval(() => {
      if (typeof window.LencoPay !== 'undefined') { clearInterval(check); resolve(true); }
      else if (Date.now() - start > timeoutMs) { clearInterval(check); resolve(false); }
    }, 100);
  });

  const handleCheckout = async (e) => {
    e.preventDefault();
    setSubmitting(true);

    // Guard: if user picked Pay Online, don't even create the order until the SDK is loadable.
    // Avoids the "I clicked Pay and got Order Placed but no popup" mystery.
    if (payOnline && store?.lencoPublicKey) {
      if (lencoSdkState === 'error') {
        setSubmitting(false);
        alert('Online payment is unavailable right now. Please choose Pay on Delivery or try again shortly.');
        return;
      }
      const ready = await waitForLencoSdk();
      if (!ready) {
        setSubmitting(false);
        alert('Payment provider is taking too long to load. Please check your connection or choose Pay on Delivery.');
        return;
      }
    }

    try {
      const { data } = await placeStoreOrder(slug, {
        ...checkoutForm,
        items: cart.map(c => ({ productId: c.productId, qty: c.qty })),
      });

      if (payOnline && store?.lencoPublicKey) {
        const nameParts = checkoutForm.customerName.trim().split(/\s+/);
        // saleId is fresh per Place-Order click, so it's unique per attempt and
        // matches what the webhook looks up.
        const paymentRef = data.saleId;
        setShowCheckout(false);
        try {
          window.LencoPay.getPaid({
            key: store.lencoPublicKey,
            reference: paymentRef,
            email: `${(checkoutForm.customerPhone || 'guest').replace(/\D/g, '')}@store.local`,
            amount: data.total,
            currency: 'ZMW',
            channels: ['card', 'mobile-money'],
            label: `Order ${data.orderNumber}`,
            customer: { firstName: nameParts[0] || '', lastName: nameParts.slice(1).join(' ') || nameParts[0] || '', phone: checkoutForm.customerPhone },
            billing: { city: checkoutForm.customerCity || '', country: 'ZM' },
            onSuccess: async (response) => {
              try {
                const { data: verify } = await verifyStorePayment(slug, { reference: response.reference || paymentRef, saleId: data.saleId });
                if (verify?.paymentStatus === 'Paid') {
                  setOrderResult({ ...data, paid: true, message: 'Payment successful! Your order is confirmed.' });
                } else {
                  setOrderResult({ ...data, paid: false, message: 'Payment received and is being verified. We will confirm shortly.' });
                }
              } catch {
                setOrderResult({ ...data, paid: false, message: 'Payment received but server verification failed. We will reconcile and contact you.' });
              }
              setCart([]); setShowCart(false);
            },
            onClose: () => {
              setOrderResult({ ...data, paid: false, message: 'Order placed. Payment was not completed -- we will contact you to arrange payment.' });
              setCart([]); setShowCart(false);
            },
            onConfirmationPending: () => {
              setOrderResult({ ...data, paid: false, message: 'Payment is being confirmed. We will update you once confirmed.' });
              setCart([]); setShowCart(false);
            },
          });
        } catch (sdkErr) {
          console.error('Lenco SDK error:', sdkErr);
          setOrderResult({ ...data, paid: false, message: 'Order placed but the payment popup failed to open. We will contact you to arrange payment.' });
          setCart([]); setShowCart(false);
        }
        setSubmitting(false);
        return;
      }

      setOrderResult(data);
      setCart([]); setShowCheckout(false); setShowCart(false);
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to place order');
    } finally { setSubmitting(false); }
  };

  // ---- LOADING ----
  if (loading) return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-slate-200 border-t-slate-800 mx-auto" />
        <p className="mt-3 text-sm text-slate-400">Loading store...</p>
      </div>
    </div>
  );

  // ---- ERROR ----
  if (error) return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center">
      <div className="text-center"><FiPackage className="mx-auto mb-3 text-slate-300" size={48} /><p className="text-slate-500 text-lg">{error}</p></div>
    </div>
  );

  // ---- PAYMENT RESULT ----
  if (paymentResult) {
    const isPaid = paymentResult.paymentStatus === 'Paid';
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl shadow-slate-200/50 p-8 max-w-md w-full text-center border border-slate-100">
          <div className={`w-20 h-20 ${isPaid ? 'bg-emerald-50' : 'bg-amber-50'} rounded-full flex items-center justify-center mx-auto mb-5`}>
            {isPaid ? <FiCheck className="text-emerald-500" size={36} /> : <FiCreditCard className="text-amber-500" size={36} />}
          </div>
          <h2 className="text-2xl font-bold text-slate-800 mb-2">{isPaid ? 'Payment Successful!' : 'Payment Pending'}</h2>
          <p className="text-slate-500 mb-6">{isPaid ? 'Your payment has been confirmed. We will process your order shortly.' : 'Your payment is being processed. We will confirm once received.'}</p>
          {paymentResult.orderNumber && (
            <div className="bg-slate-50 rounded-xl p-4 mb-3"><p className="text-xs text-slate-400 uppercase tracking-wide">Order Number</p><p className="text-xl font-bold text-slate-800 mt-1">{paymentResult.orderNumber}</p></div>
          )}
          <div className="bg-slate-50 rounded-xl p-4 mb-6">
            <p className="text-xs text-slate-400 uppercase tracking-wide">Total</p>
            <p className="text-3xl font-bold text-slate-800 mt-1">{formatMoney(paymentResult.totalPrice, store?.currency)}</p>
            <span className={`inline-block mt-2 text-xs font-semibold px-3 py-1 rounded-full ${isPaid ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{isPaid ? 'Paid' : 'Awaiting Payment'}</span>
          </div>
          {store?.phone && (
            <a href={`https://wa.me/${store.phone.replace(/[^0-9]/g, '')}`} className="inline-flex items-center gap-2 px-6 py-3 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 transition-colors mb-3 w-full justify-center font-medium"><FiPhone size={16} /> WhatsApp Us</a>
          )}
          <button onClick={() => { setPaymentResult(null); window.history.replaceState({}, '', `/store/${slug}`); }} className="text-slate-500 hover:text-slate-700 text-sm mt-2">Continue Shopping</button>
        </div>
      </div>
    );
  }

  // ---- ORDER RESULT ----
  if (orderResult) return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl shadow-slate-200/50 p-8 max-w-md w-full text-center border border-slate-100">
        <div className={`w-20 h-20 ${orderResult.paid ? 'bg-emerald-50' : 'bg-sky-50'} rounded-full flex items-center justify-center mx-auto mb-5`}>
          {orderResult.paid ? <FiCheck className="text-emerald-500" size={36} /> : <FiShoppingCart className="text-sky-500" size={36} />}
        </div>
        <h2 className="text-2xl font-bold text-slate-800 mb-2">{orderResult.paid ? 'Payment Successful!' : 'Order Placed!'}</h2>
        <p className="text-slate-500 mb-6">{orderResult.message}</p>
        <div className="bg-slate-50 rounded-xl p-4 mb-3"><p className="text-xs text-slate-400 uppercase tracking-wide">Order Number</p><p className="text-xl font-bold text-slate-800 mt-1">{orderResult.orderNumber}</p></div>
        <div className="bg-slate-50 rounded-xl p-4 mb-6">
          <p className="text-xs text-slate-400 uppercase tracking-wide">Total</p>
          <p className="text-3xl font-bold text-slate-800 mt-1">{formatMoney(orderResult.total, store?.currency)}</p>
          {orderResult.shippingCharge > 0 && <p className="text-xs text-slate-400 mt-1">includes {formatMoney(orderResult.shippingCharge, store?.currency)} delivery</p>}
        </div>
        {store?.phone && (
          <a href={`https://wa.me/${store.phone.replace(/[^0-9]/g, '')}`} className="inline-flex items-center gap-2 px-6 py-3 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 transition-colors mb-3 w-full justify-center font-medium"><FiPhone size={16} /> WhatsApp Us</a>
        )}
        <button onClick={() => { setOrderResult(null); setCheckoutForm({ customerName: '', customerPhone: '', customerCity: '', deliveryAddress: '', notes: '' }); }} className="text-slate-500 hover:text-slate-700 text-sm mt-2">Continue Shopping</button>
      </div>
    </div>
  );

  const currency = store?.currency || 'K';

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-slate-900 sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-3">
              {store?.logo && <img src={store.logo} alt="" className="w-9 h-9 rounded-lg object-contain bg-white/10 p-0.5" />}
              <div>
                <h1 className="font-bold text-white text-base leading-tight">{store?.name}</h1>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {store?.phone && (
                <a href={`tel:${store.phone}`} className="hidden sm:flex items-center gap-1.5 text-slate-300 hover:text-white text-xs transition-colors">
                  <FiPhone size={13} /> {store.phone}
                </a>
              )}
              <button onClick={() => setShowCart(true)} className="relative flex items-center gap-2 bg-white/10 hover:bg-white/20 text-white rounded-lg px-3 py-2 transition-colors">
                <FiShoppingCart size={18} />
                {cartCount > 0 && (
                  <>
                    <span className="text-sm font-medium hidden sm:inline">{formatMoney(cartTotal, currency)}</span>
                    <span className="absolute -top-1.5 -right-1.5 bg-emerald-500 text-white text-[10px] w-5 h-5 rounded-full flex items-center justify-center font-bold">{cartCount}</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Store banner */}
      {store?.storeMessage && (
        <div className="bg-emerald-600 text-white text-center py-2.5 px-4 text-sm font-medium">{store.storeMessage}</div>
      )}

      {/* Trust badges */}
      <div className="border-b border-slate-200 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2.5 flex items-center justify-center gap-6 text-xs text-slate-500 overflow-x-auto">
          <span className="flex items-center gap-1.5 whitespace-nowrap"><FiTruck size={14} className="text-slate-400" /> Nationwide Delivery</span>
          <span className="flex items-center gap-1.5 whitespace-nowrap"><FiShield size={14} className="text-slate-400" /> Secure Checkout</span>
          <span className="flex items-center gap-1.5 whitespace-nowrap"><FiCreditCard size={14} className="text-slate-400" /> Card & Mobile Money</span>
          <span className="flex items-center gap-1.5 whitespace-nowrap"><FiZap size={14} className="text-slate-400" /> Fast Response</span>
        </div>
      </div>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
        {/* Search & Filter */}
        <div className="flex flex-col sm:flex-row gap-3 mb-8">
          <div className="relative flex-1">
            <FiSearch className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
            <input type="text" placeholder="Search products..." value={search} onChange={e => handleSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-slate-800 focus:border-transparent transition-shadow shadow-sm" />
          </div>
          {categories.length > 0 && (
            <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
              <button onClick={() => handleCategory('')}
                className={`px-4 py-2 rounded-full text-sm whitespace-nowrap font-medium transition-all ${!category ? 'bg-slate-800 text-white shadow-md' : 'bg-white text-slate-600 border border-slate-200 hover:border-slate-300 hover:bg-slate-50'}`}>
                All Products
              </button>
              {categories.map(c => (
                <button key={c} onClick={() => handleCategory(c)}
                  className={`px-4 py-2 rounded-full text-sm whitespace-nowrap font-medium transition-all ${category === c ? 'bg-slate-800 text-white shadow-md' : 'bg-white text-slate-600 border border-slate-200 hover:border-slate-300 hover:bg-slate-50'}`}>
                  {c}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Products Grid */}
        {products.length > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-5">
            {products.map(p => {
              const inCart = cart.find(c => c.productId === p.id);
              const onSale = p.originalPrice && parseFloat(p.originalPrice) > parseFloat(p.sellingPrice);
              const discountPct = onSale ? Math.round(((parseFloat(p.originalPrice) - parseFloat(p.sellingPrice)) / parseFloat(p.originalPrice)) * 100) : 0;
              return (
                <div key={p.id} className={`bg-white rounded-2xl border overflow-hidden hover:shadow-lg hover:shadow-slate-200/50 transition-all duration-200 group ${onSale ? 'border-rose-200 ring-1 ring-rose-100' : 'border-slate-100'}`}>
                  <div className="aspect-square bg-slate-100 flex items-center justify-center overflow-hidden relative">
                    {p.imageUrl ? (
                      <img
                        src={p.imageUrl}
                        alt={p.name}
                        loading="lazy"
                        onError={(e) => { e.currentTarget.style.display = 'none'; if (e.currentTarget.nextSibling) e.currentTarget.nextSibling.style.display = 'flex'; }}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                      />
                    ) : null}
                    <div className={`absolute inset-0 items-center justify-center ${p.imageUrl ? 'hidden' : 'flex'}`}><FiPackage className="text-slate-300" size={40} /></div>
                    {onSale && (
                      <span className="absolute top-2 right-2 bg-rose-600 text-white text-[11px] font-bold px-2 py-0.5 rounded-full shadow-sm">-{discountPct}%</span>
                    )}
                    {p.stock <= 3 && p.stock > 0 && (
                      <span className="absolute top-2 left-2 bg-amber-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full">Only {p.stock} left</span>
                    )}
                  </div>
                  <div className="p-3 sm:p-4">
                    <h3 className="font-semibold text-slate-800 text-sm leading-snug mb-1 line-clamp-2">{p.name}</h3>
                    {p.description && <p className="text-xs text-slate-400 mb-3 line-clamp-1">{p.description}</p>}
                    <div className="mb-3 flex items-baseline gap-2 flex-wrap">
                      <p className={`font-bold text-lg ${onSale ? 'text-rose-600' : 'text-slate-900'}`}>{formatMoney(p.sellingPrice, currency)}</p>
                      {onSale && (
                        <p className="text-sm text-slate-400 line-through">{formatMoney(p.originalPrice, currency)}</p>
                      )}
                    </div>
                    <div>
                      {inCart ? (
                        <div className="flex items-center justify-between bg-slate-100 rounded-xl p-1">
                          <button onClick={() => updateQty(p.id, inCart.qty - 1)} className="w-8 h-8 flex items-center justify-center text-slate-600 hover:bg-white rounded-lg transition-colors">
                            <FiMinus size={14} />
                          </button>
                          <span className="font-bold text-slate-800 text-sm">{inCart.qty}</span>
                          <button onClick={() => updateQty(p.id, inCart.qty + 1)} className="w-8 h-8 flex items-center justify-center text-slate-600 hover:bg-white rounded-lg transition-colors" disabled={inCart.qty >= p.stock}>
                            <FiPlus size={14} />
                          </button>
                        </div>
                      ) : (
                        <div className="flex gap-2">
                          <button onClick={() => addToCart(p)}
                            className="flex-1 py-2.5 bg-slate-800 text-white text-xs font-medium rounded-xl hover:bg-slate-700 flex items-center justify-center gap-1 transition-colors">
                            <FiPlus size={12} /> Add to Cart
                          </button>
                          <button onClick={() => buyNow(p)}
                            className="py-2.5 px-4 bg-emerald-600 text-white text-xs font-medium rounded-xl hover:bg-emerald-500 flex items-center justify-center gap-1 transition-colors">
                            Buy Now
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-center py-20">
            <FiPackage className="mx-auto mb-4 text-slate-200" size={56} />
            <p className="text-slate-400 text-lg">No products found</p>
            {search && <button onClick={() => { setSearch(''); handleSearch(''); }} className="mt-2 text-sm text-slate-500 hover:text-slate-700 underline">Clear search</button>}
          </div>
        )}
      </main>

      {/* Floating cart (mobile) */}
      {cartCount > 0 && !showCart && (
        <div className="fixed bottom-4 left-4 right-4 z-20 sm:hidden">
          <button onClick={() => setShowCart(true)}
            className="w-full bg-slate-800 text-white rounded-2xl py-3.5 px-5 flex items-center justify-between shadow-xl shadow-slate-900/20">
            <span className="flex items-center gap-2.5">
              <FiShoppingCart size={18} />
              <span className="font-medium text-sm">{cartCount} item{cartCount !== 1 ? 's' : ''}</span>
            </span>
            <span className="font-bold text-sm">{formatMoney(cartTotal, currency)}</span>
          </button>
        </div>
      )}

      {/* Cart Drawer */}
      {showCart && (
        <div className="fixed inset-0 z-40">
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={() => setShowCart(false)} />
          <div className="absolute right-0 top-0 bottom-0 w-full max-w-md bg-white shadow-2xl flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <h2 className="font-bold text-lg text-slate-800">Your Cart <span className="text-slate-400 font-normal text-sm">({cartCount})</span></h2>
              <button onClick={() => setShowCart(false)} className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"><FiX size={20} /></button>
            </div>

            {cart.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-slate-300">
                <div className="text-center"><FiShoppingCart className="mx-auto mb-3" size={40} /><p className="text-slate-400">Your cart is empty</p></div>
              </div>
            ) : (
              <>
                <div className="flex-1 overflow-auto px-5 py-4 space-y-3">
                  {cart.map(item => (
                    <div key={item.productId} className="flex items-center gap-3 bg-slate-50 rounded-xl p-3">
                      <div className="w-16 h-16 bg-white rounded-xl flex items-center justify-center flex-shrink-0 border border-slate-100 overflow-hidden">
                        {item.imageUrl ? <img src={item.imageUrl} alt="" className="w-full h-full object-cover" /> : <FiPackage className="text-slate-300" size={20} />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-slate-800 text-sm truncate">{item.name}</p>
                        <p className="text-emerald-600 font-bold text-sm">{formatMoney(item.price * item.qty, currency)}</p>
                        <div className="flex items-center gap-2 mt-1.5">
                          <button onClick={() => updateQty(item.productId, item.qty - 1)} className="w-6 h-6 flex items-center justify-center bg-white border border-slate-200 rounded-md text-slate-500 hover:bg-slate-100"><FiMinus size={11} /></button>
                          <span className="w-5 text-center font-semibold text-xs text-slate-700">{item.qty}</span>
                          <button onClick={() => updateQty(item.productId, item.qty + 1)} className="w-6 h-6 flex items-center justify-center bg-white border border-slate-200 rounded-md text-slate-500 hover:bg-slate-100" disabled={item.qty >= item.stock}><FiPlus size={11} /></button>
                        </div>
                      </div>
                      <button onClick={() => removeFromCart(item.productId)} className="p-1.5 text-slate-300 hover:text-red-500 transition-colors"><FiTrash2 size={15} /></button>
                    </div>
                  ))}
                </div>

                <div className="border-t border-slate-100 px-5 py-4 space-y-3 bg-white">
                  <div className="flex justify-between items-center">
                    <span className="text-slate-500 text-sm">Subtotal</span>
                    <span className="text-xl font-bold text-slate-800">{formatMoney(cartTotal, currency)}</span>
                  </div>
                  <button onClick={() => { setShowCart(false); setShowCheckout(true); }}
                    className="w-full py-3.5 bg-slate-800 text-white font-semibold rounded-xl hover:bg-slate-700 transition-colors flex items-center justify-center gap-2">
                    Checkout <FiChevronRight size={16} />
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Checkout Modal */}
      {showCheckout && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={() => setShowCheckout(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-auto border border-slate-100">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 sticky top-0 bg-white rounded-t-2xl z-10">
              <h2 className="font-bold text-lg text-slate-800">Checkout</h2>
              <button onClick={() => setShowCheckout(false)} className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"><FiX size={20} /></button>
            </div>
            <form onSubmit={handleCheckout} className="p-5 space-y-4">
              {/* Order Summary */}
              <div className="bg-slate-50 rounded-xl p-4 space-y-2">
                <p className="text-xs text-slate-400 uppercase tracking-wide font-semibold">Order Summary</p>
                {cart.map(item => (
                  <div key={item.productId} className="flex justify-between text-sm py-1">
                    <span className="text-slate-600">{item.name} <span className="text-slate-400">x{item.qty}</span></span>
                    <span className="font-semibold text-slate-700">{formatMoney(item.price * item.qty, currency)}</span>
                  </div>
                ))}
                <div className="border-t border-slate-200 pt-2 mt-1 flex justify-between font-bold text-slate-800">
                  <span>Total</span><span className="text-lg">{formatMoney(cartTotal, currency)}</span>
                </div>
                <p className="text-[11px] text-slate-400">Delivery fee calculated based on your city</p>
              </div>

              {/* Customer Details */}
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Full Name *</label>
                  <input type="text" required value={checkoutForm.customerName} onChange={e => setCheckoutForm({ ...checkoutForm, customerName: e.target.value })}
                    placeholder="John Doe" className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-slate-800 focus:bg-white focus:border-transparent transition-all" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Phone Number *</label>
                  <input type="tel" required value={checkoutForm.customerPhone} onChange={e => setCheckoutForm({ ...checkoutForm, customerPhone: e.target.value })}
                    placeholder="0965 123 456" className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-slate-800 focus:bg-white focus:border-transparent transition-all" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">City</label>
                    <input type="text" value={checkoutForm.customerCity} onChange={e => setCheckoutForm({ ...checkoutForm, customerCity: e.target.value })}
                      placeholder="Lusaka" className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-slate-800 focus:bg-white focus:border-transparent transition-all" />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Delivery Address</label>
                    <input type="text" value={checkoutForm.deliveryAddress} onChange={e => setCheckoutForm({ ...checkoutForm, deliveryAddress: e.target.value })}
                      placeholder="Area or landmark" className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-slate-800 focus:bg-white focus:border-transparent transition-all" />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Notes (optional)</label>
                  <textarea value={checkoutForm.notes} onChange={e => setCheckoutForm({ ...checkoutForm, notes: e.target.value })} rows={2}
                    placeholder="Special instructions" className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-slate-800 focus:bg-white focus:border-transparent transition-all resize-none" />
                </div>
              </div>

              {/* Payment Method */}
              {store?.lencoPublicKey && (
                <div>
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Payment Method</p>
                  <div className="grid grid-cols-2 gap-2">
                    <button type="button" onClick={() => setPayOnline(false)}
                      className={`py-3 text-sm rounded-xl border-2 flex items-center justify-center gap-2 font-medium transition-all ${!payOnline ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-200 text-slate-500 hover:border-slate-300'}`}>
                      <FiPhone size={15} /> Pay on Delivery
                    </button>
                    <button type="button" onClick={() => setPayOnline(true)} disabled={lencoSdkState === 'error'}
                      className={`py-3 text-sm rounded-xl border-2 flex items-center justify-center gap-2 font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed ${payOnline ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-slate-200 text-slate-500 hover:border-slate-300'}`}>
                      <FiCreditCard size={15} /> Pay Online
                    </button>
                  </div>
                  {payOnline && lencoSdkState === 'ready' && <p className="text-[11px] text-slate-400 mt-2 text-center">Visa, Mastercard, MTN MoMo, Airtel Money</p>}
                  {payOnline && lencoSdkState === 'loading' && <p className="text-[11px] text-amber-500 mt-2 text-center">Loading payment provider...</p>}
                  {lencoSdkState === 'error' && <p className="text-[11px] text-red-500 mt-2 text-center">Online payment unavailable. Please choose Pay on Delivery.</p>}
                </div>
              )}

              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => setShowCheckout(false)}
                  className="flex-1 py-3 border border-slate-200 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors">Back</button>
                <button type="submit" disabled={submitting}
                  className={`flex-1 py-3 text-white rounded-xl text-sm font-semibold disabled:opacity-50 transition-colors ${payOnline ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-slate-800 hover:bg-slate-700'}`}>
                  {submitting ? 'Processing...' : payOnline ? `Pay ${formatMoney(cartTotal, currency)}` : `Place Order`}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="bg-slate-900 text-white mt-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-10">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
            <div>
              <div className="flex items-center gap-2 mb-3">
                {store?.logo && <img src={store.logo} alt="" className="w-8 h-8 rounded-lg object-contain bg-white/10 p-0.5" />}
                <span className="font-bold text-lg">{store?.name}</span>
              </div>
              <p className="text-slate-400 text-sm leading-relaxed">Your trusted source for quality products with fast delivery across Zambia.</p>
            </div>
            <div>
              <h4 className="font-semibold text-sm uppercase tracking-wide text-slate-300 mb-3">Contact</h4>
              {store?.phone && <p className="text-slate-400 text-sm flex items-center gap-2 mb-2"><FiPhone size={13} /> {store.phone}</p>}
              {store?.email && <p className="text-slate-400 text-sm mb-2">{store.email}</p>}
              {store?.address && <p className="text-slate-400 text-sm flex items-center gap-2"><FiMapPin size={13} /> {store.address}</p>}
            </div>
            <div>
              <h4 className="font-semibold text-sm uppercase tracking-wide text-slate-300 mb-3">We Accept</h4>
              <div className="flex flex-wrap gap-2">
                {['Visa', 'Mastercard', 'MTN MoMo', 'Airtel Money'].map(m => (
                  <span key={m} className="text-xs bg-white/10 text-slate-300 px-2.5 py-1 rounded-md">{m}</span>
                ))}
              </div>
            </div>
          </div>
          <div className="border-t border-slate-800 mt-8 pt-6 text-center text-xs text-slate-500">
            Powered by BizTrack
          </div>
        </div>
      </footer>
    </div>
  );
}
