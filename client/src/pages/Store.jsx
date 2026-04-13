import { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { getStoreInfo, getStoreProducts, placeStoreOrder, getPaymentStatus } from '../services/api';
import { FiShoppingCart, FiPlus, FiMinus, FiTrash2, FiX, FiPackage, FiCheck, FiPhone, FiMapPin, FiSearch, FiCreditCard, FiLoader } from 'react-icons/fi';

function formatMoney(amount, symbol = 'K') {
  const num = parseFloat(amount) || 0;
  return `${symbol}${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function Store() {
  const { slug } = useParams();
  const [searchParams] = useSearchParams();
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

  useEffect(() => {
    const orderId = searchParams.get('order');
    Promise.all([getStoreInfo(slug), getStoreProducts(slug)])
      .then(async ([infoRes, prodRes]) => {
        setStore(infoRes.data);
        setProducts(prodRes.data.products);
        setCategories(prodRes.data.categories);
        // Check if returning from payment
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

  const handleCheckout = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const { data } = await placeStoreOrder(slug, {
        ...checkoutForm,
        payOnline,
        items: cart.map(c => ({ productId: c.productId, qty: c.qty })),
      });
      if (data.paymentUrl) {
        // Redirect to BroadPay checkout
        window.location.href = data.paymentUrl;
        return;
      }
      if (data.paymentError) {
        console.error('Payment error:', data.paymentError);
      }
      setOrderResult(data);
      setCart([]);
      setShowCheckout(false);
      setShowCart(false);
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to place order');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600" />
    </div>
  );

  if (error) return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="text-center">
        <FiPackage className="mx-auto mb-3 text-gray-300" size={48} />
        <p className="text-gray-500 text-lg">{error}</p>
      </div>
    </div>
  );

  // Payment result (returning from BroadPay)
  if (paymentResult) {
    const isPaid = paymentResult.paymentStatus === 'Paid';
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-lg p-8 max-w-md w-full text-center">
          <div className={`w-16 h-16 ${isPaid ? 'bg-green-100' : 'bg-yellow-100'} rounded-full flex items-center justify-center mx-auto mb-4`}>
            {isPaid ? <FiCheck className="text-green-600" size={32} /> : <FiCreditCard className="text-yellow-600" size={32} />}
          </div>
          <h2 className="text-2xl font-bold text-gray-800 mb-2">{isPaid ? 'Payment Successful!' : 'Payment Pending'}</h2>
          <p className="text-gray-600 mb-4">
            {isPaid ? 'Your payment has been confirmed. We will process your order shortly.' : 'Your payment is being processed. We will confirm once received.'}
          </p>
          {paymentResult.orderNumber && (
            <div className="bg-gray-50 rounded-lg p-4 mb-4">
              <p className="text-sm text-gray-500">Order Number</p>
              <p className="text-xl font-bold text-blue-600">{paymentResult.orderNumber}</p>
            </div>
          )}
          <div className="bg-gray-50 rounded-lg p-4 mb-6">
            <p className="text-sm text-gray-500">Total</p>
            <p className="text-2xl font-bold text-gray-800">{formatMoney(paymentResult.totalPrice, store?.currency)}</p>
            <p className={`text-sm font-medium mt-1 ${isPaid ? 'text-green-600' : 'text-yellow-600'}`}>
              {isPaid ? 'Paid' : 'Awaiting Payment'}
            </p>
          </div>
          {store?.phone && (
            <a href={`https://wa.me/${store.phone.replace(/[^0-9]/g, '')}`}
              className="inline-flex items-center gap-2 px-6 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 mb-3 w-full justify-center">
              <FiPhone size={16} /> Contact us on WhatsApp
            </a>
          )}
          <button onClick={() => { setPaymentResult(null); window.history.replaceState({}, '', `/store/${slug}`); }}
            className="text-blue-600 hover:text-blue-800 text-sm">Continue Shopping</button>
        </div>
      </div>
    );
  }

  // Order success
  if (orderResult) return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-lg p-8 max-w-md w-full text-center">
        <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <FiCheck className="text-green-600" size={32} />
        </div>
        <h2 className="text-2xl font-bold text-gray-800 mb-2">Order Placed!</h2>
        <p className="text-gray-600 mb-4">{orderResult.message}</p>
        <div className="bg-gray-50 rounded-lg p-4 mb-4">
          <p className="text-sm text-gray-500">Order Number</p>
          <p className="text-xl font-bold text-blue-600">{orderResult.orderNumber}</p>
        </div>
        <div className="bg-gray-50 rounded-lg p-4 mb-6">
          <p className="text-sm text-gray-500">Total</p>
          <p className="text-2xl font-bold text-gray-800">{formatMoney(orderResult.total, store?.currency)}</p>
          {orderResult.shippingCharge > 0 && <p className="text-xs text-gray-400">includes {formatMoney(orderResult.shippingCharge, store?.currency)} shipping</p>}
        </div>
        {store?.phone && (
          <a href={`https://wa.me/${store.phone.replace(/[^0-9]/g, '')}`}
            className="inline-flex items-center gap-2 px-6 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 mb-3 w-full justify-center">
            <FiPhone size={16} /> Contact us on WhatsApp
          </a>
        )}
        <button onClick={() => { setOrderResult(null); setCheckoutForm({ customerName: '', customerPhone: '', customerCity: '', deliveryAddress: '', notes: '' }); }}
          className="text-blue-600 hover:text-blue-800 text-sm">Continue Shopping</button>
      </div>
    </div>
  );

  const currency = store?.currency || 'K';

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {store?.logo && <img src={store.logo} alt="" className="w-10 h-10 rounded-lg object-contain" />}
            <div>
              <h1 className="font-bold text-gray-800 text-lg leading-tight">{store?.name}</h1>
              <p className="text-xs text-gray-400">Online Store</p>
            </div>
          </div>
          <button onClick={() => setShowCart(true)} className="relative p-2 text-gray-600 hover:text-blue-600">
            <FiShoppingCart size={24} />
            {cartCount > 0 && (
              <span className="absolute -top-1 -right-1 bg-blue-600 text-white text-xs w-5 h-5 rounded-full flex items-center justify-center font-bold">
                {cartCount}
              </span>
            )}
          </button>
        </div>
      </header>

      {/* Store message */}
      {store?.storeMessage && (
        <div className="bg-blue-600 text-white text-center py-2 px-4 text-sm">{store.storeMessage}</div>
      )}

      <main className="max-w-6xl mx-auto px-4 py-6">
        {/* Search & Filter */}
        <div className="flex flex-col sm:flex-row gap-3 mb-6">
          <div className="relative flex-1">
            <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
            <input type="text" placeholder="Search products..." value={search} onChange={e => handleSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 border border-gray-300 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-500 bg-white" />
          </div>
          {categories.length > 0 && (
            <div className="flex gap-2 overflow-x-auto pb-1">
              <button onClick={() => handleCategory('')}
                className={`px-3 py-2 rounded-lg text-sm whitespace-nowrap ${!category ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 border border-gray-300 hover:bg-gray-50'}`}>
                All
              </button>
              {categories.map(c => (
                <button key={c} onClick={() => handleCategory(c)}
                  className={`px-3 py-2 rounded-lg text-sm whitespace-nowrap ${category === c ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 border border-gray-300 hover:bg-gray-50'}`}>
                  {c}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Products Grid */}
        {products.length > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {products.map(p => {
              const inCart = cart.find(c => c.productId === p.id);
              return (
                <div key={p.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden hover:shadow-lg transition-shadow">
                  <div className="aspect-square bg-gray-100 flex items-center justify-center">
                    {p.imageUrl ? (
                      <img src={p.imageUrl} alt={p.name} className="w-full h-full object-cover" />
                    ) : (
                      <FiPackage className="text-gray-300" size={40} />
                    )}
                  </div>
                  <div className="p-3">
                    <h3 className="font-medium text-gray-800 text-sm leading-tight mb-1 line-clamp-2">{p.name}</h3>
                    {p.description && <p className="text-xs text-gray-400 mb-2 line-clamp-1">{p.description}</p>}
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-blue-600 text-lg">{formatMoney(p.sellingPrice, currency)}</span>
                      {p.stock <= 3 && <span className="text-xs text-orange-500">{p.stock} left</span>}
                    </div>
                    <div className="mt-2">
                      {inCart ? (
                        <div className="flex items-center justify-between bg-blue-50 rounded-lg p-1">
                          <button onClick={() => updateQty(p.id, inCart.qty - 1)} className="p-1.5 text-blue-600 hover:bg-blue-100 rounded">
                            <FiMinus size={16} />
                          </button>
                          <span className="font-bold text-blue-700">{inCart.qty}</span>
                          <button onClick={() => updateQty(p.id, inCart.qty + 1)} className="p-1.5 text-blue-600 hover:bg-blue-100 rounded"
                            disabled={inCart.qty >= p.stock}>
                            <FiPlus size={16} />
                          </button>
                        </div>
                      ) : (
                        <div className="flex gap-1.5">
                          <button onClick={() => addToCart(p)}
                            className="flex-1 py-2 bg-blue-600 text-white text-xs rounded-lg hover:bg-blue-700 flex items-center justify-center gap-1">
                            <FiPlus size={12} /> Add to Cart
                          </button>
                          <button onClick={() => buyNow(p)}
                            className="flex-1 py-2 bg-green-600 text-white text-xs rounded-lg hover:bg-green-700 flex items-center justify-center gap-1">
                            <FiShoppingCart size={12} /> Buy Now
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
          <div className="text-center py-16">
            <FiPackage className="mx-auto mb-3 text-gray-300" size={48} />
            <p className="text-gray-500">No products found</p>
          </div>
        )}
      </main>

      {/* Floating cart button (mobile) */}
      {cartCount > 0 && !showCart && (
        <div className="fixed bottom-4 left-4 right-4 z-20 sm:hidden">
          <button onClick={() => setShowCart(true)}
            className="w-full bg-blue-600 text-white rounded-xl py-3 px-4 flex items-center justify-between shadow-lg hover:bg-blue-700">
            <span className="flex items-center gap-2">
              <FiShoppingCart size={20} />
              <span className="font-medium">{cartCount} item{cartCount !== 1 ? 's' : ''}</span>
            </span>
            <span className="font-bold">{formatMoney(cartTotal, currency)}</span>
          </button>
        </div>
      )}

      {/* Cart Drawer */}
      {showCart && (
        <div className="fixed inset-0 z-40">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowCart(false)} />
          <div className="absolute right-0 top-0 bottom-0 w-full max-w-md bg-white shadow-xl flex flex-col">
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="font-bold text-lg text-gray-800">Cart ({cartCount})</h2>
              <button onClick={() => setShowCart(false)} className="p-1 text-gray-400 hover:text-gray-600"><FiX size={24} /></button>
            </div>

            {cart.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-gray-400">
                <div className="text-center">
                  <FiShoppingCart className="mx-auto mb-2" size={32} />
                  <p>Your cart is empty</p>
                </div>
              </div>
            ) : (
              <>
                <div className="flex-1 overflow-auto p-4 space-y-3">
                  {cart.map(item => (
                    <div key={item.productId} className="flex items-center gap-3 bg-gray-50 rounded-lg p-3">
                      <div className="w-14 h-14 bg-gray-200 rounded-lg flex items-center justify-center flex-shrink-0">
                        {item.imageUrl ? <img src={item.imageUrl} alt="" className="w-full h-full object-cover rounded-lg" /> : <FiPackage className="text-gray-400" size={20} />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-gray-800 text-sm truncate">{item.name}</p>
                        <p className="text-blue-600 font-bold text-sm">{formatMoney(item.price, currency)}</p>
                      </div>
                      <div className="flex items-center gap-1">
                        <button onClick={() => updateQty(item.productId, item.qty - 1)} className="p-1 text-gray-400 hover:text-gray-600"><FiMinus size={14} /></button>
                        <span className="w-6 text-center font-medium text-sm">{item.qty}</span>
                        <button onClick={() => updateQty(item.productId, item.qty + 1)} className="p-1 text-gray-400 hover:text-gray-600"
                          disabled={item.qty >= item.stock}><FiPlus size={14} /></button>
                      </div>
                      <p className="font-bold text-sm w-20 text-right">{formatMoney(item.price * item.qty, currency)}</p>
                      <button onClick={() => removeFromCart(item.productId)} className="p-1 text-red-400 hover:text-red-600"><FiTrash2 size={14} /></button>
                    </div>
                  ))}
                </div>

                <div className="border-t p-4 space-y-3">
                  <div className="flex justify-between text-lg font-bold text-gray-800">
                    <span>Total</span>
                    <span>{formatMoney(cartTotal, currency)}</span>
                  </div>
                  <button onClick={() => { setShowCart(false); setShowCheckout(true); }}
                    className="w-full py-3 bg-blue-600 text-white font-medium rounded-xl hover:bg-blue-700">
                    Checkout
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
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowCheckout(false)} />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-auto">
            <div className="flex items-center justify-between p-4 border-b sticky top-0 bg-white rounded-t-2xl z-10">
              <h2 className="font-bold text-lg text-gray-800">Checkout</h2>
              <button onClick={() => setShowCheckout(false)} className="p-1 text-gray-400 hover:text-gray-600"><FiX size={20} /></button>
            </div>
            <form onSubmit={handleCheckout} className="p-4 space-y-4">
              {/* Order Summary */}
              <div className="bg-gray-50 rounded-lg p-3 space-y-2">
                <p className="text-sm font-medium text-gray-700">Order Summary</p>
                {cart.map(item => (
                  <div key={item.productId} className="flex justify-between text-sm">
                    <span className="text-gray-600">{item.name} x{item.qty}</span>
                    <span className="font-medium">{formatMoney(item.price * item.qty, currency)}</span>
                  </div>
                ))}
                <div className="border-t pt-2 flex justify-between font-bold text-gray-800">
                  <span>Total</span>
                  <span>{formatMoney(cartTotal, currency)}</span>
                </div>
                <p className="text-xs text-gray-400">Shipping will be calculated based on your city</p>
              </div>

              {/* Customer Details */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Your Name *</label>
                <input type="text" required value={checkoutForm.customerName} onChange={e => setCheckoutForm({ ...checkoutForm, customerName: e.target.value })}
                  placeholder="Full name" className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Phone Number *</label>
                <input type="tel" required value={checkoutForm.customerPhone} onChange={e => setCheckoutForm({ ...checkoutForm, customerPhone: e.target.value })}
                  placeholder="e.g. 0965123456" className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">City</label>
                <input type="text" value={checkoutForm.customerCity} onChange={e => setCheckoutForm({ ...checkoutForm, customerCity: e.target.value })}
                  placeholder="e.g. Lusaka" className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Delivery Address</label>
                <input type="text" value={checkoutForm.deliveryAddress} onChange={e => setCheckoutForm({ ...checkoutForm, deliveryAddress: e.target.value })}
                  placeholder="Street address or landmark" className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes (optional)</label>
                <textarea value={checkoutForm.notes} onChange={e => setCheckoutForm({ ...checkoutForm, notes: e.target.value })} rows={2}
                  placeholder="Any special instructions" className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
              </div>

              {store?.paymentEnabled && (
                <div className="bg-gray-50 rounded-lg p-3">
                  <p className="text-sm font-medium text-gray-700 mb-2">Payment Method</p>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setPayOnline(false)}
                      className={`flex-1 py-2.5 text-sm rounded-lg border flex items-center justify-center gap-1.5 transition-colors ${!payOnline ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-300 text-gray-700 hover:bg-gray-100'}`}>
                      <FiPhone size={14} /> Pay Later
                    </button>
                    <button type="button" onClick={() => setPayOnline(true)}
                      className={`flex-1 py-2.5 text-sm rounded-lg border flex items-center justify-center gap-1.5 transition-colors ${payOnline ? 'bg-green-600 text-white border-green-600' : 'border-gray-300 text-gray-700 hover:bg-gray-100'}`}>
                      <FiCreditCard size={14} /> Pay Now
                    </button>
                  </div>
                  {payOnline && <p className="text-xs text-gray-400 mt-2">You'll be redirected to a secure payment page (Visa, Mastercard, Mobile Money)</p>}
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowCheckout(false)}
                  className="flex-1 py-2.5 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Back</button>
                <button type="submit" disabled={submitting}
                  className={`flex-1 py-2.5 text-white rounded-lg text-sm font-medium disabled:opacity-50 ${payOnline ? 'bg-green-600 hover:bg-green-700' : 'bg-blue-600 hover:bg-blue-700'}`}>
                  {submitting ? 'Processing...' : payOnline ? `Pay ${formatMoney(cartTotal, currency)}` : `Place Order - ${formatMoney(cartTotal, currency)}`}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="bg-white border-t mt-12 py-6">
        <div className="max-w-6xl mx-auto px-4 text-center text-sm text-gray-400">
          <p>{store?.name}</p>
          {store?.phone && <p className="mt-1"><FiPhone className="inline mr-1" size={12} />{store.phone}</p>}
          {store?.address && <p className="mt-1"><FiMapPin className="inline mr-1" size={12} />{store.address}</p>}
          <p className="mt-3 text-xs">Powered by BizTrack</p>
        </div>
      </footer>
    </div>
  );
}
